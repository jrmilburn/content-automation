// @vitest-environment jsdom

import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
  it("identifies the internal content intelligence workspace", () => {
    render(createElement(HomePage));

    expect(
      screen.getByRole("heading", { level: 1, name: "Content intelligence workspace" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Studio Parallel/)).toBeInTheDocument();
  });
});
