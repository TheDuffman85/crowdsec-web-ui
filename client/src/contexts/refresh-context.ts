import { createContext } from 'react';
import type { RefreshContextValue } from '../types';

export const RefreshContext = createContext<RefreshContextValue | undefined>(undefined);
