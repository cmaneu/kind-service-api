using './azure.bicep'

param kubernetesVersion = readEnvironmentVariable('IDENTITY_POC_KUBERNETES_VERSION')
param windowsAdminPassword = readEnvironmentVariable('IDENTITY_POC_WINDOWS_PASSWORD')
