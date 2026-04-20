"use client";

/**
 * MarkdownContent — Lightweight markdown renderer for AI agent output.
 *
 * Renders markdown text as styled React elements using react-markdown + remark-gfm.
 * Optimized for the dark-themed ThoughtPanel (right-hand timeline) with compact
 * typography suited to the 36rem panel width.
 *
 * Features:
 *   - GitHub-Flavored Markdown: tables, strikethrough, task lists, autolinks
 *   - Dark theme via Tailwind utility classes on custom component overrides
 *   - Secure by default: react-markdown strips raw HTML (no rehype-raw)
 *   - External links open in new tabs with rel="noopener noreferrer"
 *
 * No rehype-raw, rehype-sanitize, or rehype-highlight — content comes from
 * the AI agent (trusted source) and react-markdown's default HTML stripping
 * provides sufficient XSS protection.
 *
 * Reference: copilot_plans_research/MARKDOWN_WEB_VIEW.md §1–§5
 */

import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// ---------------------------------------------------------------------------
// Custom component overrides — dark-theme Tailwind styling.
// Each element is styled to match the neutral-950/900/800 palette used
// throughout the ThoughtPanel. Compact sizes (text-xs / text-[11px]) suit
// the 36rem panel width.
// ---------------------------------------------------------------------------

const mdComponents: Components = {
  /* --- Block elements --- */
  h1: ({ children }) => (
    <h1 className="mb-1.5 mt-2 text-sm font-bold text-neutral-200">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1 mt-2 text-xs font-bold text-neutral-200">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-0.5 mt-1.5 text-xs font-semibold text-neutral-300">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="mb-1.5 text-xs leading-relaxed text-neutral-300">
      {children}
    </p>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-neutral-600 pl-2 italic text-neutral-500">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 border-neutral-700" />,

  /* --- Lists --- */
  ul: ({ children }) => (
    <ul className="my-1 list-inside list-disc space-y-0.5 text-xs text-neutral-400">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 list-inside list-decimal space-y-0.5 text-xs text-neutral-400">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="text-xs text-neutral-400">{children}</li>
  ),

  /* --- Tables (GFM) — wrapped in overflow container for narrow panel --- */
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-neutral-800/50">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border border-neutral-700 px-2 py-1 text-left font-semibold text-neutral-300">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-neutral-700 px-2 py-1 text-neutral-400">
      {children}
    </td>
  ),

  /* --- Code — block (pre>code) vs inline (code) --- */
  pre: ({ children }) => (
    <pre className="my-1.5 max-h-60 overflow-auto rounded bg-neutral-900 p-2 font-mono text-[11px] leading-relaxed text-neutral-400 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
      {children}
    </pre>
  ),
  code: ({ children, ...props }) => (
    <code
      className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-cyan-300"
      {...props}
    >
      {children}
    </code>
  ),

  /* --- Inline elements --- */
  strong: ({ children }) => (
    <strong className="font-semibold text-neutral-200">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="italic text-neutral-400">{children}</em>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-400 underline hover:text-blue-300"
    >
      {children}
    </a>
  ),

  /* --- Images (display inline, max-width constrained) --- */
  img: ({ src, alt }) => {
    if (!src) return null;
    return (
      <img
        src={src}
        alt={alt ?? ""}
        className="my-1 max-w-full rounded"
        loading="lazy"
      />
    );
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Props for the MarkdownContent component. */
export interface MarkdownContentProps {
  /** Raw markdown string to render. */
  content: string;
}

/**
 * Renders markdown content with dark-theme styling and GFM support.
 * Designed for the ThoughtPanel timeline's compact layout.
 */
export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
      {content}
    </Markdown>
  );
}
