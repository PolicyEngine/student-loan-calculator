"use client";

import { Header, type CountryConfig, type NavItemConfig } from "@policyengine/ui-kit";

const navItems: NavItemConfig[] = [
  { label: "Research", href: "https://policyengine.org/uk/research" },
  { label: "Model", href: "https://policyengine.org/uk/model" },
  { label: "API", href: "https://policyengine.org/uk/api" },
  {
    label: "About",
    href: "https://policyengine.org/uk/team",
    children: [
      { label: "Team", href: "https://policyengine.org/uk/team" },
      { label: "Supporters", href: "https://policyengine.org/uk/supporters" },
    ],
  },
  { label: "Donate", href: "https://policyengine.org/uk/donate" },
];

const countries: CountryConfig[] = [
  { id: "us", label: "United States" },
  { id: "uk", label: "United Kingdom" },
];

export default function PolicyEngineHeader() {
  return (
    <Header
      className="policyengine-site-header"
      navItems={navItems}
      countries={countries}
      currentCountry="uk"
      logoHref="https://policyengine.org/uk"
      onCountryChange={(countryId) => {
        window.location.href = `https://policyengine.org/${countryId}`;
      }}
    />
  );
}
