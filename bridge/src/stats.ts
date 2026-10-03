import type { AgentStats } from './model.js';
import type { TranscriptResult } from './transcript.js';

// An agent's work record, as the office tycoon sees it: how many instructions it got (today and
// in total), how many tools it ran and subagents it sent out, and when it was "hired".

function sameLocalDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export function agentStats(t: Pick<TranscriptResult, 'messages' | 'calls'>, now = new Date()): AgentStats {
  let instructions = 0;
  let instructionsToday = 0;
  let toolCalls = 0;
  let toolCallsToday = 0;
  let hiredAt: string | null = null;
  for (const m of t.messages) {
    if (!hiredAt && m.ts) hiredAt = m.ts;
    if (m.role === 'user') {
      instructions++;
      if (m.ts && sameLocalDay(m.ts, now)) instructionsToday++;
    } else if (m.role === 'tool') {
      toolCalls++;
      if (m.ts && sameLocalDay(m.ts, now)) toolCallsToday++;
    }
  }
  return { instructions, instructionsToday, toolCalls, toolCallsToday, subagents: t.calls.length, hiredAt };
}
