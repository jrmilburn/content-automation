// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/posts/01900000" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));
vi.mock("../app/actions", () => ({ endSession: vi.fn() }));

import { AppShell } from "./app-shell";

function installDialogMethods() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
}

describe("AppShell", () => {
  beforeEach(() => {
    installDialogMethods();
    navigation.pathname = "/posts/01900000";
  });

  it("exposes canonical primary and secondary landmarks with active-route semantics", () => {
    render(
      <AppShell>
        <h1>Post detail</h1>
      </AppShell>,
    );

    const primaryNavigations = screen.getAllByRole("navigation", { name: "Primary" });
    expect(primaryNavigations).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Posts" })[0]).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getAllByRole("link", { name: "Instagram accounts" })[0]).toHaveAttribute(
      "href",
      "/accounts",
    );
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("opens the mobile sheet, focuses its first destination and restores the menu trigger", () => {
    render(
      <AppShell>
        <h1>Posts</h1>
      </AppShell>,
    );

    const menuButton = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(menuButton);

    const dialog = screen.getByRole("dialog", { name: "Workspace navigation" });
    expect(dialog).toHaveAttribute("open");
    expect(dialog.querySelector("a")).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: /Close/ }));
    expect(dialog).not.toHaveAttribute("open");
    expect(menuButton).toHaveFocus();
  });
});
