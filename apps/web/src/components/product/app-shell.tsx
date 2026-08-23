'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  Building2,
  CheckSquare2,
  ChevronDown,
  FileChartColumn,
  Inbox,
  LayoutDashboard,
  Search,
  Settings2,
  ShieldAlert,
  Workflow,
  X,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { MeResponse } from '@leadops/core';
import type { ProductSection } from '@/lib/product/types';

interface NavigationItem {
  label: string;
  section: ProductSection;
  icon: LucideIcon;
  count?: number;
}

const workspaceNavigation: NavigationItem[] = [
  { label: 'Overview', section: 'overview', icon: LayoutDashboard },
  { label: 'Leads', section: 'leads', icon: Inbox },
  { label: 'Approvals', section: 'approvals', icon: CheckSquare2 },
  { label: 'Automations', section: 'automations', icon: Workflow },
  { label: 'Incidents', section: 'incidents', icon: ShieldAlert },
  { label: 'Reports', section: 'reports', icon: FileChartColumn },
];

const agencyNavigation: NavigationItem[] = [
  { label: 'Clients', section: 'clients', icon: Building2 },
  { label: 'Settings', section: 'settings', icon: Settings2 },
];

function BrandMark() {
  return (
    <Link className="brand" href="/?section=overview" aria-label="LeadOps overview">
      <span className="brand-mark" aria-hidden="true">
        <Activity size={18} strokeWidth={2.4} />
      </span>
      <span className="brand-wordmark">LeadOps</span>
    </Link>
  );
}

function buildHref(section: ProductSection, clientId: string): string {
  return `/?section=${section}&client=${encodeURIComponent(clientId)}`;
}

function NavigationGroup({
  label,
  items,
  activeSection,
  clientId,
}: {
  label: string;
  items: NavigationItem[];
  activeSection: ProductSection;
  clientId: string;
}) {
  return (
    <div className="nav-group">
      <p className="nav-label">{label}</p>
      <nav aria-label={`${label} navigation`}>
        {items.map(({ label: itemLabel, section, icon: Icon, count }) => {
          const active = section === activeSection;
          return (
            <a
              key={section}
              aria-current={active ? 'page' : undefined}
              className={`nav-item${active ? ' nav-item-active' : ''}`}
              href={buildHref(section, clientId)}
            >
              <Icon aria-hidden="true" size={18} strokeWidth={1.9} />
              <span>{itemLabel}</span>
              {count ? <span className="nav-count">{count}</span> : null}
            </a>
          );
        })}
      </nav>
    </div>
  );
}

function ClientBoundary({ me, selectedClientId }: { me: MeResponse; selectedClientId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedClient =
    me.clients.find((client) => client.id === selectedClientId) ?? me.clients[0];

  function switchClient(clientId: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('client', clientId);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="client-boundary">
      <div className="client-boundary-label">
        <span className="boundary-dot" aria-hidden="true" />
        <span>Client workspace</span>
      </div>
      <label className="client-select-wrap">
        <span className="sr-only">Switch client workspace</span>
        <span className="client-avatar" aria-hidden="true">
          {selectedClient?.name
            .split(/\s+/u)
            .map((part) => part[0])
            .join('')
            .slice(0, 2)
            .toUpperCase() ?? '—'}
        </span>
        <select
          className="client-select"
          value={selectedClientId}
          onChange={(event) => {
            switchClient(event.target.value);
          }}
        >
          {me.clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
        <ChevronDown className="client-select-icon" size={15} aria-hidden="true" />
      </label>
    </div>
  );
}

function TopBar({
  me,
  selectedClientId,
  onSearchOpen,
}: {
  me: MeResponse;
  selectedClientId: string;
  onSearchOpen: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar-mobile-brand">
        <BrandMark />
      </div>
      <ClientBoundary me={me} selectedClientId={selectedClientId} />
      <div className="topbar-actions">
        <button
          className="search-button"
          type="button"
          aria-label="Search workspace"
          onClick={onSearchOpen}
        >
          <Search size={17} aria-hidden="true" />
          <span>Search workspace</span>
          <kbd>⌘ K</kbd>
        </button>
        <a
          className="icon-button notification-button"
          href={buildHref('incidents', selectedClientId)}
          aria-label="Open incident notifications"
        >
          <Bell size={18} aria-hidden="true" />
          <span className="notification-dot" aria-label="1 unread notification" />
        </a>
        <div className="profile-button" aria-label={`Signed in as ${me.user.name}`}>
          <span className="profile-avatar">
            {me.user.name
              .split(/\s+/u)
              .map((part) => part[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()}
          </span>
          <span className="profile-copy">
            <strong>{me.user.name}</strong>
            <small>{me.organization.role.replaceAll('_', ' ')}</small>
          </span>
        </div>
      </div>
    </header>
  );
}

function SearchDialog({
  clientId,
  clientLevel,
  onClose,
}: {
  clientId: string;
  clientLevel: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const items = clientLevel ? workspaceNavigation : [...workspaceNavigation, ...agencyNavigation];
  const matches = items.filter((item) =>
    item.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div
      className="command-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="command-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-title"
      >
        <header className="command-header">
          <Search size={18} aria-hidden="true" />
          <label>
            <span className="sr-only" id="command-title">
              Search workspace pages
            </span>
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Go to a workspace page…"
            />
          </label>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close search">
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <div className="command-results">
          {matches.map(({ label, section, icon: Icon }) => (
            <a key={section} href={buildHref(section, clientId)} onClick={onClose}>
              <span>
                <Icon size={17} aria-hidden="true" />
                {label}
              </span>
              <small>
                {workspaceNavigation.some((item) => item.section === section)
                  ? 'Workspace'
                  : 'Agency'}
              </small>
            </a>
          ))}
          {matches.length === 0 ? <p>No matching page</p> : null}
        </div>
        <footer className="command-footer">
          <span>Navigate with the keyboard</span>
          <kbd>Esc</kbd>
          <span>to close</span>
        </footer>
      </section>
    </div>
  );
}

export function AppShell({
  children,
  me,
  selectedClientId,
  activeSection,
  pendingApprovals,
  openIncidents,
  mode,
}: {
  children: ReactNode;
  me: MeResponse;
  selectedClientId: string;
  activeSection: ProductSection;
  pendingApprovals: number;
  openIncidents: number;
  mode: 'live' | 'demo';
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const workspaceItems = workspaceNavigation.map((item) =>
    item.section === 'approvals'
      ? { ...item, count: pendingApprovals }
      : item.section === 'incidents'
        ? { ...item, count: openIncidents }
        : item,
  );
  const clientLevel = me.organization.role.startsWith('client_');

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === 'Escape') setSearchOpen(false);
    }
    window.addEventListener('keydown', handleKeyboard);
    return () => {
      window.removeEventListener('keydown', handleKeyboard);
    };
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <BrandMark />
          <span className={`environment-badge ${mode === 'live' ? 'environment-live' : ''}`}>
            {mode === 'live' ? 'Live' : 'Demo'}
          </span>
        </div>
        <div className="sidebar-content">
          <NavigationGroup
            label="Workspace"
            items={workspaceItems}
            activeSection={activeSection}
            clientId={selectedClientId}
          />
          {!clientLevel ? (
            <NavigationGroup
              label="Agency"
              items={agencyNavigation}
              activeSection={activeSection}
              clientId={selectedClientId}
            />
          ) : null}
        </div>
        <div className="sidebar-footer">
          <div className="confidence-card">
            <span className="confidence-pulse" aria-hidden="true" />
            <span>
              <strong>Human decisions stay final</strong>
              <small>AI recommends. Your team remains in control.</small>
            </span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <TopBar
          me={me}
          selectedClientId={selectedClientId}
          onSearchOpen={() => {
            setSearchOpen(true);
          }}
        />
        <main id="main-content" className="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <nav className="mobile-navigation" aria-label="Mobile navigation">
        {workspaceItems.slice(0, 5).map(({ label, section, icon: Icon, count }) => {
          const active = section === activeSection;
          return (
            <a
              key={section}
              className={active ? 'mobile-nav-item mobile-nav-item-active' : 'mobile-nav-item'}
              href={buildHref(section, selectedClientId)}
              aria-current={active ? 'page' : undefined}
            >
              <span className="mobile-nav-icon">
                <Icon size={19} strokeWidth={1.9} aria-hidden="true" />
                {count ? <span className="mobile-nav-count">{count}</span> : null}
              </span>
              <span>{label}</span>
            </a>
          );
        })}
      </nav>
      {searchOpen ? (
        <SearchDialog
          clientId={selectedClientId}
          clientLevel={clientLevel}
          onClose={() => {
            setSearchOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
