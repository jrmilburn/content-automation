// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import RootError from "./error";

describe("RootError", () => {
  it("announces the failure through a main landmark and focused page heading", async () => {
    render(<RootError error={new Error("test failure")} reset={vi.fn()} />);

    expect(screen.getByRole("main")).toBeInTheDocument();
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "This view did not load",
    });
    await waitFor(() => expect(heading).toHaveFocus());
  });
});
