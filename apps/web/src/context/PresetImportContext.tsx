'use client';

import React, { createContext, useContext, useState } from 'react';

interface PresetImportContextType {
  importing: boolean;
  importError: string | null;
  importSuccess: string | null;
  setImporting: (val: boolean) => void;
  setImportError: (val: string | null) => void;
  setImportSuccess: (val: string | null) => void;
}

const PresetImportContext = createContext<PresetImportContextType | undefined>(undefined);

export function PresetImportProvider({ children }: { children: React.ReactNode }) {
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  return (
    <PresetImportContext.Provider value={{
      importing,
      importError,
      importSuccess,
      setImporting,
      setImportError,
      setImportSuccess
    }}>
      {children}
    </PresetImportContext.Provider>
  );
}

export function usePresetImport() {
  const context = useContext(PresetImportContext);
  if (!context) {
    throw new Error('usePresetImport must be used within a PresetImportProvider');
  }
  return context;
}
