// Stable selectors for buttons in the sidebar, so focus survives a re-render (and a modal closing).
const q = (s: string): string => s.replace(/["\\]/g, '\\$&');

export function focusSelector(el: Element | null): string | null {
  if (!(el instanceof HTMLElement) || el.tagName !== 'BUTTON') return null;
  const cls = el.classList[0];
  if (!cls) return null;
  const agent = el.dataset.agent;
  if (agent !== undefined) return `button.agent-open[data-agent="${q(agent)}"]`;
  const stop = el.dataset.stop;
  if (stop !== undefined) return `button.stop-agent[data-stop="${q(stop)}"]`;
  const desk = el.closest<HTMLElement>('[data-desk]')?.dataset.desk;
  if (desk !== undefined) return `[data-desk="${q(desk)}"] button.${cls}`;
  const repo = el.closest<HTMLElement>('[data-repo]')?.dataset.repo;
  if (repo !== undefined) return `[data-repo="${q(repo)}"] button.${cls}`;
  return `button.${cls}`;
}
