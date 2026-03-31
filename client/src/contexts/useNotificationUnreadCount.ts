import { useContext } from 'react';
import type { NotificationUnreadContextValue } from '../types';
import { NotificationUnreadContext } from './notification-unread-context';

export function useNotificationUnreadCount(): NotificationUnreadContextValue {
  const context = useContext(NotificationUnreadContext);
  if (!context) {
    throw new Error('useNotificationUnreadCount must be used within NotificationUnreadProvider');
  }
  return context;
}
