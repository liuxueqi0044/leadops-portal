'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  Bell,
  Building2,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  FileChartColumn,
  Inbox,
  LayoutDashboard,
  MoreHorizontal,
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
import { useDialogFocus } from './use-dialog-focus';

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

const mobileSections: ProductSection[] = ['overview', 'leads', 'approvals', 'incidents'];

function BrandMark({ clientId }: { clientId: string }) {
  return (
    <Link className="brand" href={buildHref('overview', clientId)} aria-label="LeadOps overview">
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
    params.delete('lead');
    params.delete('approval');
    params.delete('incident');
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
  activeSection,
  openIncidents,
  onSearchOpen,
}: {
  me: MeResponse;
  selectedClientId: string;
  activeSection: ProductSection;
  openIncidents: number;
  onSearchOpen: () => void;
}) {
  const activeItem = [...workspaceNavigation, ...agencyNavigation].find(
    (item) => item.section === activeSection,
  );

  return (
    <header className="topbar">
      <div className="topbar-context">
        <div className="topbar-mobile-brand">
          <BrandMark clientId={selectedClientId} />
        </div>
        <nav className="topbar-breadcrumb" aria-label="Breadcrumb">
          <span>
            {agencyNavigation.some((item) => item.section === activeSection)
              ? 'Agency'
              : 'Workspace'}
          </span>
          <ChevronRight size={13} aria-hidden="true" />
          <strong className="topbar-section" aria-current="page">
            {activeItem?.label ?? 'Overview'}
          </strong>
        </nav>
      </div>
      <ClientBoundary me={me} selectedClientId={selectedClientId} />
      <div className="topbar-actions">
        <button
          className="search-button"
          type="button"
          aria-label="Search workspace pages"
          aria-haspopup="dialog"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={onSearchOpen}
        >
          <Search size={17} aria-hidden="true" />
          <span>Search workspace</span>
          <kbd>⌘ K</kbd>
        </button>
        <a
          className="icon-button notification-button"
          href={buildHref('incidents', selectedClientId)}
          aria-label={`${String(openIncidents)} open ${openIncidents === 1 ? 'incident' : 'incidents'}. View incidents`}
        >
          <Bell size={18} aria-hidden="true" />
          {openIncidents > 0 ? <span className="notification-dot" aria-hidden="true" /> : null}
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
  openerRef,
}: {
  clientId: string;
  clientLevel: boolean;
  onClose: () => void;
  openerRef: RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState('');
  const dialogRef = useDialogFocus(onClose, openerRef);
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
        ref={dialogRef}
        className="command-dialog"
        role="dialog"
        tabIndex={-1}
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
              data-dialog-autofocus
              type="search"
              autoComplete="off"
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
          {matches.length === 0 ? <p role="status">No matching page</p> : null}
        </div>
        <footer className="command-footer">
          <span>Tab to navigate · Enter to open</span>
          <kbd>Esc</kbd>
          <span>to close</span>
        </footer>
      </section>
    </div>
  );
}

function MobileNavigationDialog({
  clientId,
  activeSection,
  workspaceItems,
  clientLevel,
  onClose,
  openerRef,
}: {
  clientId: string;
  activeSection: ProductSection;
  workspaceItems: NavigationItem[];
  clientLevel: boolean;
  onClose: () => void;
  openerRef: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useDialogFocus(onClose, openerRef);
  const groups = [
    { label: 'Workspace', items: workspaceItems },
    ...(!clientLevel ? [{ label: 'Agency', items: agencyNavigation }] : []),
  ];

  return (
    <div
      className="command-backdrop mobile-menu-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialogRef}
        id="mobile-workspace-menu"
        className="mobile-menu-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="mobile-menu-title"
        aria-describedby="mobile-menu-description"
      >
        <header className="mobile-menu-header">
          <div>
            <h2 id="mobile-menu-title">Your workspace</h2>
            <p className="mobile-menu-description" id="mobile-menu-description">
              Move between your operations and tools.
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        <nav className="mobile-menu-navigation" aria-label="All workspace pages">
          {groups.map((group) => (
            <div className="mobile-menu-section" key={group.label}>
              <p className="nav-label">{group.label}</p>
              {group.items.map(({ label, section, icon: Icon, count }) => (
                <a
                  key={section}
                  href={buildHref(section, clientId)}
                  onClick={onClose}
                  aria-current={activeSection === section ? 'page' : undefined}
                  className={`mobile-menu-link${activeSection === section ? ' mobile-menu-link-active' : ''}`}
                >
                  <Icon size={19} aria-hidden="true" />
                  <span>{label}</span>
                  {count ? <span className="mobile-menu-count">{count}</span> : null}
                  <ChevronRight size={15} aria-hidden="true" />
                </a>
              ))}
            </div>
          ))}
        </nav>
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
  const [activeDialog, setActiveDialog] = useState<'search' | 'navigation' | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openDialog = useCallback((dialog: 'search' | 'navigation') => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest('.command-dialog, .mobile-menu-dialog')) {
      openerRef.current = active;
    }
    setActiveDialog(dialog);
  }, []);
  const closeDialog = useCallback(() => {
    setActiveDialog(null);
  }, []);
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
        openDialog('search');
      }
    }
    window.addEventListener('keydown', handleKeyboard);
    return () => {
      window.removeEventListener('keydown', handleKeyboard);
    };
  }, [openDialog]);

  return (
    <div className="app-shell">
      <aside className="sidebar" inert={activeDialog !== null}>
        <div className="sidebar-header">
          <BrandMark clientId={selectedClientId} />
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
      <div className="workspace" inert={activeDialog !== null}>
        <TopBar
          me={me}
          selectedClientId={selectedClientId}
          activeSection={activeSection}
          openIncidents={openIncidents}
          onSearchOpen={() => {
            openDialog('search');
          }}
        />
        <main id="main-content" className="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <nav
        className="mobile-navigation"
        aria-label="Mobile navigation"
        inert={activeDialog !== null}
      >
        {workspaceItems
          .filter((item) => mobileSections.includes(item.section))
          .map(({ label, section, icon: Icon, count }) => {
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
        <button
          className={`mobile-nav-item${!mobileSections.includes(activeSection) ? ' mobile-nav-item-active' : ''}`}
          type="button"
          aria-label="More workspace pages"
          aria-haspopup="dialog"
          aria-expanded={activeDialog === 'navigation'}
          aria-controls={activeDialog === 'navigation' ? 'mobile-workspace-menu' : undefined}
          onClick={() => {
            openDialog('navigation');
          }}
        >
          <span className="mobile-nav-icon">
            <MoreHorizontal size={20} aria-hidden="true" />
          </span>
          <span>More</span>
        </button>
      </nav>
      {activeDialog === 'search' ? (
        <SearchDialog
          clientId={selectedClientId}
          clientLevel={clientLevel}
          onClose={closeDialog}
          openerRef={openerRef}
        />
      ) : null}
      {activeDialog === 'navigation' ? (
        <MobileNavigationDialog
          clientId={selectedClientId}
          activeSection={activeSection}
          workspaceItems={workspaceItems}
          clientLevel={clientLevel}
          onClose={closeDialog}
          openerRef={openerRef}
        />
      ) : null}
    </div>
  );
}
