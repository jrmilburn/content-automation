// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import DashboardPage from "./page";

describe("DashboardPage", () => {
  it("uses the canonical dashboard location and safe setup action", () => {
    render(<DashboardPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Instagram accounts" })).toHaveAttribute(
      "href",
      "/accounts",
    );
  });
});
