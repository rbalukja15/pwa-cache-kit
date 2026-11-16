import type { TierName } from '@rbalukja/pwa-cache-kit';
import './style.css';
import { cache, fetchTickets, TICKETS_KEY, wallet, type Ticket } from './tickets.js';

const TIER_LABELS: Record<TierName, string> = {
  memory: 'memory',
  session: 'SessionStorage',
  indexeddb: 'IndexedDB',
};

function element(testId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`missing element ${testId}`);
  return found;
}

const list = element('tickets');
const source = element('source');
const connection = element('connection');
const refresh = element('refresh') as HTMLButtonElement;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function render(tickets: readonly Ticket[]): void {
  list.replaceChildren(
    ...tickets.map((ticket) => {
      const item = document.createElement('li');
      item.className = 'ticket';
      item.dataset['testid'] = 'ticket';
      const title = document.createElement('h2');
      title.textContent = ticket.event;
      const details = document.createElement('p');
      details.textContent = `${ticket.venue} · ${dateFormat.format(new Date(ticket.startsAt))}`;
      const seat = document.createElement('p');
      seat.className = 'seat';
      seat.textContent = `${ticket.section} · Seat ${ticket.seat}`;
      const code = document.createElement('code');
      code.textContent = ticket.code;
      item.append(title, details, seat, code);
      return item;
    }),
  );
}

// The cache's events say where each read was served from; the inspector (#16) builds on them too.
const read: { servedBy?: string } = {};
/** Read through a call: the handlers set the field during the awaits, out of the checker's view. */
const servedBy = (): string | undefined => read.servedBy;
cache.on('hit', (event) => {
  if (event.key === TICKETS_KEY) read.servedBy = `Served from ${TIER_LABELS[event.tier]}.`;
});
cache.on('miss', (event) => {
  if (event.key === TICKETS_KEY && event.reason === 'stale') {
    read.servedBy = `Served a saved copy from ${TIER_LABELS[event.tier]}; refreshing in the background.`;
  }
});
cache.on('set', (event) => {
  if (event.key === TICKETS_KEY && event.reason === 'load' && event.tier === 'memory') {
    read.servedBy = 'Loaded from the network.';
  }
});
cache.on('error', (event) => {
  if (event.error.code === 'LOADER_FAILED') {
    source.textContent = 'Offline: showing your saved tickets.';
  } else {
    console.warn(event.error);
  }
});

async function load(): Promise<void> {
  delete read.servedBy;
  try {
    const tickets = await wallet.getOrSet(TICKETS_KEY, fetchTickets);
    render(tickets);
    source.textContent = servedBy() ?? 'Ready.';
  } catch {
    source.textContent = 'You are offline and no tickets are saved on this device yet.';
  }
}

refresh.addEventListener('click', () => {
  void (async () => {
    refresh.disabled = true;
    try {
      const tickets = await fetchTickets();
      await wallet.set(TICKETS_KEY, tickets);
      render(tickets);
      source.textContent = 'Refreshed from the network.';
    } catch {
      source.textContent = 'Could not reach the network; keeping your saved tickets.';
    } finally {
      refresh.disabled = false;
    }
  })();
});

function showConnection(): void {
  connection.textContent = navigator.onLine ? 'Online' : 'Offline';
  connection.dataset['state'] = navigator.onLine ? 'online' : 'offline';
}
window.addEventListener('online', showConnection);
window.addEventListener('offline', showConnection);
showConnection();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((error: unknown) => {
    console.warn('service worker registration failed', error);
  });
}

void load();
