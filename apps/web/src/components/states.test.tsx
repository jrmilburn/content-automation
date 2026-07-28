// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmationDialog } from "./confirmation-dialog";
import { EmptyState, ErrorSummary, LoadingState, PartialState, StatusMessage } from "./states";

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

describe("shared workspace states", () => {
  beforeEach(installDialogMethods);

  it("announces labelled loading without exposing skeleton decoration", () => {
    render(<LoadingState label="posts" />);

    expect(screen.getByText("Loading posts")).toBeInTheDocument();
    expect(screen.getByText("Loading posts").closest("section")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("gives empty and partial states explicit prerequisites and actions", () => {
    const { rerender } = render(
      <EmptyState
        action={{ href: "/accounts", label: "Open Instagram accounts" }}
        description="Connect an account before posts can populate."
        title="No posts imported"
      />,
    );

    expect(screen.getByText("Not yet available")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Instagram accounts" })).toHaveAttribute(
      "href",
      "/accounts",
    );

    rerender(
      <PartialState
        available={<p>Post metadata is available.</p>}
        missing="Comparable metric snapshots"
        title="Some evidence is still loading"
      />,
    );
    expect(screen.getByText("Partial data")).toBeInTheDocument();
    expect(screen.getByText(/Comparable metric snapshots/)).toBeInTheDocument();
  });

  it("explains failed work, data safety and a safe retry route", () => {
    render(
      <ErrorSummary
        action={{ href: "/operations", label: "Open Operations" }}
        correlationId="019873d5-31e6-7c59-a531-1f2f4cbce221"
        description="The sync failed. Imported data is unchanged."
        title="Instagram sync did not finish"
      />,
    );

    const summary = screen
      .getByRole("heading", {
        level: 2,
        name: "Instagram sync did not finish",
      })
      .closest("section");
    expect(summary).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(/Imported data is unchanged/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Operations" })).toHaveAttribute(
      "href",
      "/operations",
    );
  });

  it("uses a polite atomic region for asynchronous messages", () => {
    render(<StatusMessage>Analysis queued. The browser can be closed.</StatusMessage>);

    expect(screen.getByText(/Analysis queued/)).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(/Analysis queued/)).toHaveAttribute("aria-atomic", "true");
  });

  it("moves focus into confirmation and restores it when closed", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmationDialog
        confirmLabel="Disconnect account"
        description="Existing imported data remains available."
        onConfirm={onConfirm}
        title="Disconnect this Instagram account?"
        triggerLabel="Disconnect"
      />,
    );

    const trigger = screen.getByRole("button", { name: "Disconnect" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect account" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });
});
