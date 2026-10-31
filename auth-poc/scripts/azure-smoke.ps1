#Requires -Version 7.4
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$local = Join-Path $root ".azure"
$kubeconfig = Join-Path $local "kubeconfig"
Get-Command kubectl, node -ErrorAction Stop | Out-Null
if (!(Test-Path $kubeconfig) -or !(Test-Path (Join-Path $local "entra-ca.pem"))) {
    throw "Run scripts/azure-up.ps1 first."
}

$forwards = @()
$oldTarget = $env:IDENTITY_POC_TARGET
try {
    foreach ($port in @(3000, 8443)) {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
        try { $listener.Start() } finally { $listener.Stop() }
    }
    foreach ($service in @(@("api", 3000), @("entra-local", 8443))) {
        $name, $port = $service
        $forwards += Start-Process -FilePath (Get-Command kubectl).Source -ArgumentList @(
            "--kubeconfig", "`"$kubeconfig`"", "--context", "identity-poc-azure",
            "-n", "identity-poc", "port-forward", "service/$name", "${port}:${port}", "--address=127.0.0.1"
        ) -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $local "$name-forward.log") `
          -RedirectStandardError (Join-Path $local "$name-forward.err")
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if ($forwards.Where({ $_.HasExited }).Count) {
            throw "Port forwarding failed. Inspect .azure/*-forward.err."
        }
        $apiReady = (Get-Content (Join-Path $local "api-forward.log") -Raw) -match "Forwarding from 127.0.0.1:3000"
        $entraReady = (Get-Content (Join-Path $local "entra-local-forward.log") -Raw) -match "Forwarding from 127.0.0.1:8443"
        if ($apiReady -and $entraReady) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (!$ready) { throw "Port forwarding timed out. Inspect .azure/*-forward.err." }
    $env:IDENTITY_POC_TARGET = "azure"
    & node (Join-Path $PSScriptRoot "smoke.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Azure Windows smoke tests failed." }
} finally {
    $env:IDENTITY_POC_TARGET = $oldTarget
    foreach ($process in $forwards) {
        if (!$process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    }
}
