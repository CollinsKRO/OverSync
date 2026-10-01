import React, { createContext, useContext, ReactNode } from 'react';

interface DeploymentRecord {
  registryAddress: string;
  escrowAddress: string;
  networkId: string;
  bytecodeHashes: Record<string, string>;
}

interface DeploymentContextType {
  deploymentRecord: DeploymentRecord | null;
}

const DeploymentContext = createContext<DeploymentContextType>({
  deploymentRecord: null
});

interface DeploymentProviderProps {
  children: ReactNode;
  value: DeploymentContextType;
}

export const DeploymentProvider: React.FC<DeploymentProviderProps> = ({ children, value }) => {
  return (
    <DeploymentContext.Provider value={value}>
      {children}
    </DeploymentContext.Provider>
  );
};

export const useDeploymentContext = (): DeploymentContextType => {
  return useContext(DeploymentContext);
};

export { DeploymentContext };
