import { createContext } from 'react';
import type { NotificationUnreadContextValue } from '../types';

export const NotificationUnreadContext = createContext<NotificationUnreadContextValue | undefined>(undefined);
