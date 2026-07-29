// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import TermsPage from "./page";

describe("TermsPage", () => {
  it("limits access to approved staff rather than implying public sign-up", () => {
    render(<TermsPage />);

    expect(screen.getByText(/no self-service registration/iu)).toBeInTheDocument();
    expect(screen.getByText(/no public sign-up/iu)).toBeInTheDocument();
  });

  it("requires the uploader to hold rights in the video they upload", () => {
    render(<TermsPage />);

    expect(screen.getByText(/only video you have the rights to use/iu)).toBeInTheDocument();
  });

  it("separates measured figures from generated interpretation", () => {
    render(<TermsPage />);

    const section = screen.getByRole("heading", {
      level: 2,
      name: "What the analysis is, and is not",
    }).parentElement;

    expect(section).not.toBeNull();
    expect(section?.textContent).toMatch(/shown as unavailable, never as zero/u);
    expect(section?.textContent).toMatch(/not a guarantee of any result/u);
    expect(section?.textContent).toMatch(/how any platform’s ranking works/u);
  });

  it("links to the privacy policy where it describes third-party processing", () => {
    render(<TermsPage />);

    expect(screen.getByRole("link", { name: "privacy policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });

  it("marks unresolved legal details visibly", () => {
    render(<TermsPage />);

    expect(screen.getByText("[registered legal entity to be confirmed]")).toBeInTheDocument();
    expect(screen.getByText("[jurisdiction to be confirmed]")).toBeInTheDocument();
  });

  it("gives a contact route and a last-updated date", () => {
    render(<TermsPage />);

    expect(screen.getByRole("link", { name: "team@studioparallel.com.au" })).toHaveAttribute(
      "href",
      "mailto:team@studioparallel.com.au",
    );

    const updated = screen.getByText(/^Last updated/u);

    expect(within(updated).getByText(/2026/u)).toHaveAttribute("datetime", "2026-07-29");
  });

  it("starts a single level-one heading and nests the rest beneath it", () => {
    render(<TermsPage />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Terms of use" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(4);
  });
});
