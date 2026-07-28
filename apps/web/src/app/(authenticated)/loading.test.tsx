// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import WorkspaceLoading from "./loading";

describe("WorkspaceLoading", () => {
  it("preserves current-location and page-heading structure while loading", () => {
    render(<WorkspaceLoading />);

    expect(screen.getByText("Studio Parallel workspace")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Loading workspace" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Loading current workspace view")).toBeInTheDocument();
  });
});
