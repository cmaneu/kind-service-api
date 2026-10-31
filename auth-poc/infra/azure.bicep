targetScope = 'resourceGroup'

param location string = resourceGroup().location
param clusterName string = 'identity-poc-win'
param linuxVmSize string = 'Standard_D2s_v5'
param windowsVmSize string = 'Standard_D4s_v5'
param windowsAdminUsername string = 'akswinadmin'

@description('An AKS version available in this region supporting Windows2025 (1.32 or later).')
param kubernetesVersion string

@secure()
@minLength(14)
param windowsAdminPassword string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'identity${uniqueString(resourceGroup().id)}'
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource aks 'Microsoft.ContainerService/managedClusters@2025-02-01' = {
  name: clusterName
  location: location
  identity: { type: 'SystemAssigned' }
  sku: { name: 'Base', tier: 'Free' }
  properties: {
    dnsPrefix: clusterName
    kubernetesVersion: kubernetesVersion
    enableRBAC: true
    windowsProfile: {
      adminUsername: windowsAdminUsername
      adminPassword: windowsAdminPassword
    }
    agentPoolProfiles: [
      {
        name: 'system'
        count: 1
        vmSize: linuxVmSize
        osType: 'Linux'
        osSKU: 'AzureLinux'
        mode: 'System'
        type: 'VirtualMachineScaleSets'
      }
      {
        name: 'win'
        count: 1
        vmSize: windowsVmSize
        osType: 'Windows'
        osSKU: 'Windows2025'
        mode: 'User'
        type: 'VirtualMachineScaleSets'
        nodeTaints: ['os=windows:NoSchedule']
      }
    ]
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      loadBalancerSku: 'standard'
      outboundType: 'loadBalancer'
    }
  }
}

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, aks.id, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: aks.properties.identityProfile.kubeletidentity.objectId
    principalType: 'ServicePrincipal'
  }
}

output clusterName string = aks.name
output registryName string = registry.name
output registryServer string = registry.properties.loginServer
