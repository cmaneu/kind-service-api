#Requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string]$KubernetesVersion,
    [string]$Location = "eastus",
    [string]$ClusterName = "identity-poc-win",
    [string]$LinuxVmSize = "Standard_D2s_v5",
    [string]$WindowsVmSize = "Standard_D4s_v5"
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$local = Join-Path $root ".azure"
$kubeconfig = Join-Path $local "kubeconfig"

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

Get-Command az, docker, kubectl, node -ErrorAction Stop | Out-Null
if ((Invoke-Checked docker @("info", "--format", "{{.OSType}}")).Trim() -ne "windows") {
    throw "Use a Windows container Docker engine compatible with Windows Server 2025."
}
Invoke-Checked az @("account", "show", "--output", "none")
New-Item -ItemType Directory -Force $local | Out-Null
Push-Location $root
try {
    $password = Read-Host "Windows node admin password (14+ characters; reuse on redeployment)" -AsSecureString
    $oldPassword = $env:IDENTITY_POC_WINDOWS_PASSWORD
    $oldVersion = $env:IDENTITY_POC_KUBERNETES_VERSION
    try {
        $env:IDENTITY_POC_WINDOWS_PASSWORD = [System.Net.NetworkCredential]::new("", $password).Password
        $env:IDENTITY_POC_KUBERNETES_VERSION = $KubernetesVersion
        Invoke-Checked az @("group", "create", "--name", $ResourceGroup, "--location", $Location, "--output", "none")
        $result = Invoke-Checked az @(
            "deployment", "group", "create", "--resource-group", $ResourceGroup,
            "--name", "identity-poc-windows", "--parameters", (Join-Path $root "infra/azure.bicepparam"),
            "clusterName=$ClusterName", "linuxVmSize=$LinuxVmSize", "windowsVmSize=$WindowsVmSize",
            "--query", "properties.outputs", "--output", "json"
        )
        $outputs = ($result -join "`n") | ConvertFrom-Json
    } finally {
        $env:IDENTITY_POC_WINDOWS_PASSWORD = $oldPassword
        $env:IDENTITY_POC_KUBERNETES_VERSION = $oldVersion
        $password.Dispose()
    }

    Invoke-Checked az @(
        "aks", "get-credentials", "--resource-group", $ResourceGroup,
        "--name", $outputs.clusterName.value, "--file", $kubeconfig,
        "--context", "identity-poc-azure", "--overwrite-existing", "--output", "none"
    )
    $connection = @("--kubeconfig", $kubeconfig, "--context", "identity-poc-azure")
    Invoke-Checked az @("acr", "login", "--name", $outputs.registryName.value)
    $tag = Get-Date -Format "yyyyMMddHHmmss"
    $manifest = (Invoke-Checked kubectl @("kustomize", (Join-Path $root "infra"))) -join "`n"
    foreach ($app in @("api", "worker")) {
        $image = "$($outputs.registryServer.value)/identity-poc-${app}:$tag"
        Invoke-Checked docker @("build", "--pull", "-f", "Dockerfile.windows", "--target", $app, "-t", $image, ".")
        Invoke-Checked docker @("push", $image)
        $manifest = $manifest.Replace("identity-poc-${app}:windows", $image)
    }
    $manifestFile = Join-Path $local "apps.yaml"
    Set-Content -Path $manifestFile -Value $manifest -Encoding utf8
    Invoke-Checked kubectl ($connection + @("apply", "-f", $manifestFile))
    Invoke-Checked kubectl ($connection + @(
        "rollout", "status", "-n", "identity-poc", "deployment/entra-local", "--timeout=600s"
    ))
    $certificate = Invoke-Checked kubectl ($connection + @(
        "exec", "-n", "identity-poc", "deployment/entra-local", "--", "node", "-e",
        'process.stdout.write(require("node:fs").readFileSync("/app/data/tls/cert.pem","utf8"))'
    ))
    $certificateFile = Join-Path $local "entra-ca.pem"
    Set-Content -Path $certificateFile -Value $certificate -Encoding utf8
    Invoke-Checked node @("--input-type=module", "-e",
        'import { X509Certificate } from "node:crypto"; import { readFileSync } from "node:fs"; new X509Certificate(readFileSync(process.argv[1]));',
        $certificateFile)
    $configMap = Invoke-Checked kubectl ($connection + @(
        "create", "configmap", "entra-ca", "-n", "identity-poc",
        "--from-file=ca.pem=$certificateFile", "--dry-run=client", "-o", "json"
    ))
    $configMapFile = Join-Path $local "ca-configmap.json"
    Set-Content -Path $configMapFile -Value $configMap -Encoding utf8
    Invoke-Checked kubectl ($connection + @("apply", "-f", $configMapFile))
    Invoke-Checked kubectl ($connection + @(
        "rollout", "restart", "-n", "identity-poc", "deployment/api", "deployment/reporting-worker"
    ))
    foreach ($app in @("api", "reporting-worker")) {
        Invoke-Checked kubectl ($connection + @(
            "rollout", "status", "-n", "identity-poc", "deployment/$app", "--timeout=1200s"
        ))
    }
    Write-Host "Ready. Run ./scripts/azure-smoke.ps1 to test through localhost-only port forwards."
} finally {
    Pop-Location
}
