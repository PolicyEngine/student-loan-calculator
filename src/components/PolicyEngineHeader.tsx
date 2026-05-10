"use client";

import { PolicyEngineHeader as ShellHeader } from "@policyengine/ui-kit/layout";

export default function PolicyEngineHeader() {
  return (
    <div aria-label="PolicyEngine site header">
      <ShellHeader country="uk" />
    </div>
  );
}
