/**
 * THESIS: A studio work ledger frames current location and safe action; it refuses the ornamental
 * dashboard grid. OWN-WORLD: dark ink navigation, warm paper canvas, crisp rules, compact controls.
 * STORY: locate the workspace area, identify attention, act without losing provenance. FIRST
 * VIEWPORT: stable rail at left, current page command line and one bounded state at right; the menu
 * becomes a modal sheet at 390px. FORM: fourth grounded structure, persistent frame with focused
 * work canvas, seed 4af905ab.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { endSession } from "../app/actions";

const primaryNavigation = [
  { href: "/", label: "Dashboard" },
  { href: "/posts", label: "Posts" },
  { href: "/trends", label: "Trends" },
  { href: "/strategy", label: "Strategy" },
  { href: "/chat", label: "Assistant" },
  { href: "/operations", label: "Operations" },
] as const;

const secondaryNavigation = [
  { href: "/settings/integrations", label: "Instagram accounts" },
  { href: "/settings", label: "Settings" },
] as const;

function matchesRoute(pathname: string, href: string): boolean {
  return href === "/" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Resolves the one destination to mark as current.
 *
 * Nested destinations overlap — `/settings/integrations` also matches
 * `/settings` — so the longest match wins and exactly one link is announced as
 * the current page.
 */
export function activeNavigationHref(pathname: string): string | null {
  return [...primaryNavigation, ...secondaryNavigation]
    .map((item) => item.href)
    .filter((href) => matchesRoute(pathname, href))
    .reduce<string | null>(
      (best, href) => (best === null || href.length > best.length ? href : best),
      null,
    );
}

function NavigationLinks({ onNavigate }: Readonly<{ onNavigate?: () => void }>) {
  const pathname = usePathname();
  const activeHref = activeNavigationHref(pathname);

  function navigationList(
    items: ReadonlyArray<Readonly<{ href: string; label: string }>>,
    label: string,
  ) {
    return (
      <nav aria-label={label}>
        <ul className="navigation-list">
          {items.map((item) => {
            const active = item.href === activeHref;
            return (
              <li key={item.href}>
                <Link
                  className="navigation-link"
                  href={item.href}
                  {...(active ? { "aria-current": "page" as const } : {})}
                  {...(onNavigate ? { onClick: onNavigate } : {})}
                >
                  <span aria-hidden="true" className="navigation-link__marker" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  return (
    <>
      {navigationList(primaryNavigation, "Primary")}
      <div className="navigation-secondary">
        <p className="navigation-label">Workspace</p>
        {navigationList(secondaryNavigation, "Workspace")}
      </div>
    </>
  );
}

function SessionMenu() {
  return (
    <details className="session-menu">
      <summary>Session</summary>
      <div className="session-menu__panel">
        <p>
          <strong>Workspace member</strong>
          <span>Approved internal access</span>
        </p>
        <form action={endSession}>
          <button className="button button--nav" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}

function Brand() {
  return (
    <Link aria-label="Studio Parallel dashboard" className="brand" href="/">
      <span className="brand__mark" aria-hidden="true">
        SP
      </span>
      <span>
        <strong>Studio Parallel</strong>
        <small>Content intelligence</small>
      </span>
    </Link>
  );
}

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  function closeMenu() {
    if (dialogRef.current?.open) dialogRef.current.close();
    menuButtonRef.current?.focus();
  }

  function openMenu() {
    dialogRef.current?.showModal();
    dialogRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className="app-shell">
        <aside aria-label="Workspace navigation" className="desktop-navigation">
          <Brand />
          <div className="navigation-body">
            <NavigationLinks />
          </div>
          <SessionMenu />
        </aside>

        <header className="mobile-header">
          <Brand />
          <button
            aria-controls="mobile-navigation"
            className="menu-button"
            onClick={openMenu}
            ref={menuButtonRef}
            type="button"
          >
            <span aria-hidden="true" className="menu-button__glyph">
              <span />
              <span />
            </span>
            Menu
          </button>
        </header>

        <dialog
          aria-label="Workspace navigation"
          className="mobile-navigation"
          id="mobile-navigation"
          onCancel={(event) => {
            event.preventDefault();
            closeMenu();
          }}
          ref={dialogRef}
        >
          <div className="mobile-navigation__header">
            <p>Navigate workspace</p>
            <button className="menu-close" onClick={closeMenu} type="button">
              <span aria-hidden="true">×</span> Close
            </button>
          </div>
          <div className="mobile-navigation__body">
            <NavigationLinks onNavigate={closeMenu} />
          </div>
          <SessionMenu />
        </dialog>

        <main className="app-content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </>
  );
}
