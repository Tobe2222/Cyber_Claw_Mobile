/**
 * Message grouping utilities for organizing chat/log by date
 */

export type DateGroup = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'older';

export interface GroupedMessage<T> {
  group: DateGroup;
  label: string;
  messages: T[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

function getDayOfWeek(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[date.getDay()];
}

function getDateGroup(timestamp: number): { group: DateGroup; label: string } {
  const now = new Date();
  const messageDate = new Date(timestamp);

  // Normalize to start of day for comparison
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(messageDate.getFullYear(), messageDate.getMonth(), messageDate.getDate());

  const diffMs = today.getTime() - msgDay.getTime();
  const diffDays = Math.floor(diffMs / MS_PER_DAY);

  if (diffDays === 0) {
    return { group: 'today', label: 'Today' };
  }

  if (diffDays === 1) {
    return { group: 'yesterday', label: 'Yesterday' };
  }

  if (diffDays > 1 && diffDays <= 7) {
    const dayName = getDayOfWeek(messageDate);
    return { group: 'this_week', label: `This Week (${dayName})` };
  }

  if (diffDays > 7 && diffDays <= 14) {
    return { group: 'last_week', label: 'Last Week' };
  }

  return { group: 'older', label: 'Older' };
}

export function groupMessagesByDate<T extends { timestamp: number }>(messages: T[]): GroupedMessage<T>[] {
  const groups: Map<DateGroup, GroupedMessage<T>> = new Map();
  const groupOrder: DateGroup[] = ['today', 'yesterday', 'this_week', 'last_week', 'older'];

  for (const msg of messages) {
    const { group, label } = getDateGroup(msg.timestamp);

    if (!groups.has(group)) {
      groups.set(group, { group, label, messages: [] });
    }

    groups.get(group)!.messages.push(msg);
  }

  // Return in chronological order, newest first
  return groupOrder
    .filter(g => groups.has(g))
    .map(g => groups.get(g)!)
    .reverse();
}
