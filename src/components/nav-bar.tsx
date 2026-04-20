"use client";

/**
 * NavBar — Vertical left-hand navigation bar.
 *
 * Two links: "New Title" (FilePlus icon) and "History" (History icon).
 * Highlights the active route. Dark sidebar matching the neutral-900 shell.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FilePlus, History } from "lucide-react";

/** Navigation items rendered in the sidebar. */
const NAV_ITEMS = [
  { href: "/new", label: "New Title", icon: FilePlus },
  { href: "/history", label: "History", icon: History },
] as const;

export function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="flex h-full w-56 flex-col border-r border-neutral-700 bg-neutral-950 px-3 py-6">
      <h2 className="mb-8 px-2 text-sm font-bold uppercase tracking-wider text-neutral-400">
        HCD Agent
      </h2>
      <ul className="flex flex-col gap-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href;
          return (
            <li key={href}>
              <Link
                href={href}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-neutral-700 text-white"
                    : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
