// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PrivacyPage from "./page";

describe("PrivacyPage", () => {
  it("names the exact Instagram permissions requested", () => {
    render(<PrivacyPage />);

    expect(screen.getByText("instagram_business_basic")).toBeInTheDocument();
    expect(screen.getByText("instagram_business_manage_insights")).toBeInTheDocument();
  });

  it("states what the tool cannot read, so scope is not overstated", () => {
    render(<PrivacyPage />);

    expect(
      screen.getByText(/do not request, and cannot read, direct messages/i),
    ).toBeInTheDocument();
  });

  it("discloses the paid Gemini tier and that files are deleted after processing", () => {
    render(<PrivacyPage />);

    const processors = screen.getByRole("heading", {
      level: 2,
      name: "Services that process data for us",
    }).parentElement;

    expect(processors).not.toBeNull();

    const geminiEntry = within(processors as HTMLElement)
      .getByText(/Google Gemini/u)
      .closest("li");

    expect(geminiEntry?.textContent).toMatch(/paid, billing-enabled project/u);
    expect(geminiEntry?.textContent).toMatch(/not used to improve Google’s products/u);
    expect(geminiEntry?.textContent).toMatch(/expire at Google within 48 hours/u);
  });

  it("publishes a retention period for every category it collects", () => {
    render(<PrivacyPage />);

    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");

    // One header row plus one row per retained category.
    expect(rows.length).toBeGreaterThan(1);
    expect(
      within(table).getByRole("rowheader", { name: "Instagram access credentials" }),
    ).toBeInTheDocument();
    expect(within(table).getByText("Purged on disconnect")).toBeInTheDocument();
  });

  it("gives a working contact route for access and deletion requests", () => {
    render(<PrivacyPage />);

    const contactLinks = screen.getAllByRole("link", { name: "team@studioparallel.com.au" });

    expect(contactLinks.length).toBeGreaterThan(0);
    expect(contactLinks[0]).toHaveAttribute("href", "mailto:team@studioparallel.com.au");
  });

  it("records when the policy was last updated", () => {
    render(<PrivacyPage />);

    const updated = screen.getByText(/^Last updated/u);
    const stamp = within(updated).getByText(/2026/u);

    expect(stamp).toHaveAttribute("datetime", "2026-07-29");
    expect(stamp.tagName).toBe("TIME");
  });

  it("marks unresolved legal details visibly so the page cannot ship half-finished", () => {
    render(<PrivacyPage />);

    expect(screen.getByText("[registered legal entity to be confirmed]")).toBeInTheDocument();
    expect(screen.getAllByText("[jurisdiction to be confirmed]").length).toBeGreaterThan(0);
  });

  it("starts a single level-one heading and nests the rest beneath it", () => {
    render(<PrivacyPage />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(4);
  });
});
