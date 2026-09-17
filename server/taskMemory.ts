import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ReminderTask } from "../shared/types";

export class TaskMemory extends EventEmitter {
  private readonly tasks = new Map<string, ReminderTask>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  list(): ReminderTask[] {
    return [...this.tasks.values()].sort((a, b) => a.triggerAt.localeCompare(b.triggerAt));
  }

  schedule(task: Omit<ReminderTask, "taskId" | "status">): ReminderTask {
    const reminder: ReminderTask = {
      ...task,
      taskId: randomUUID(),
      status: "scheduled"
    };
    this.tasks.set(reminder.taskId, reminder);

    const delay = Math.max(0, new Date(reminder.triggerAt).getTime() - Date.now());
    const timer = setTimeout(() => this.fire(reminder.taskId), delay);
    this.timers.set(reminder.taskId, timer);
    return reminder;
  }

  private fire(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "scheduled") return;
    task.status = "fired";
    this.tasks.set(taskId, task);
    this.timers.delete(taskId);
    this.emit("fired", task);
  }
}

export function extractReminder(queryText: string, createdByAgentId: string): Omit<ReminderTask, "taskId" | "status"> | undefined {
  if (!/(提醒|监督|时间到|写作业|看电视)/.test(queryText)) return undefined;

  const triggerAt = parseTriggerTime(queryText);
  if (!triggerAt) return undefined;

  const audience = /小朋友|孩子|小孩|宝宝/.test(queryText) ? "小朋友" : "用户";
  const message = /写作业/.test(queryText)
    ? "电视时间到啦，我们一起收好心情去写作业吧。"
    : "时间到啦，该做约定好的事情了。";

  return {
    createdByAgentId,
    triggerAt: triggerAt.toISOString(),
    audience,
    message,
    reminderAgentId: "little-fox"
  };
}

function parseTriggerTime(text: string): Date | undefined {
  const now = new Date();
  const minuteMatch = text.match(/(\d+)\s*分钟后/);
  if (minuteMatch) {
    return new Date(now.getTime() + Number(minuteMatch[1]) * 60_000);
  }
  const chineseMinuteMatch = text.match(/([一二两三四五六七八九十])\s*分钟后/);
  if (chineseMinuteMatch) {
    return new Date(now.getTime() + chineseNumberToInteger(chineseMinuteMatch[1]) * 60_000);
  }

  const secondMatch = text.match(/(\d+)\s*秒后/);
  if (secondMatch) {
    return new Date(now.getTime() + Number(secondMatch[1]) * 1_000);
  }
  const chineseSecondMatch = text.match(/([一二两三四五六七八九十])\s*秒后/);
  if (chineseSecondMatch) {
    return new Date(now.getTime() + chineseNumberToInteger(chineseSecondMatch[1]) * 1_000);
  }

  const hourMinuteMatch = text.match(/(?:今天)?\s*(\d{1,2})[点:：](\d{1,2})?/);
  if (hourMinuteMatch) {
    const target = new Date(now);
    target.setHours(Number(hourMinuteMatch[1]));
    target.setMinutes(hourMinuteMatch[2] ? Number(hourMinuteMatch[2]) : 0);
    target.setSeconds(0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target;
  }

  return undefined;
}

function chineseNumberToInteger(text: string): number {
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10
  };
  return map[text] ?? 1;
}
