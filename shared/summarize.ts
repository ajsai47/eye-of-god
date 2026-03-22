/**
 * Generate a 1-2 sentence summary of what a Claude Code instance is likely
 * working on, based on its working directory and git context.
 *
 * Uses OpenAI's gpt-5.4-nano for cheap, fast inference.
 * Requires OPENAI_API_KEY environment variable.
 * Falls back gracefully if unavailable.
 */

export async function generateSummary(context: {
  cwd: string;
  git_root: string | null;
  git_branch?: string | null;
  recent_files?: string[];
}): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const parts = [`Working directory: ${context.cwd}`];
  if (context.git_root) {
    parts.push(`Git repo root: ${context.git_root}`);
  }
  if (context.git_branch) {
    parts.push(`Branch: ${context.git_branch}`);
  }
  if (context.recent_files && context.recent_files.length > 0) {
    parts.push(`Recently modified files: ${context.recent_files.join(", ")}`);
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-nano",
        messages: [
          {
            role: "system",
            content:
              "You generate brief summaries of what a developer is working on based on their project context. Respond with exactly 1-2 sentences, no more. Be specific about the project name and likely task.",
          },
          {
            role: "user",
            content: `Based on this context, what is this developer likely working on?\n\n${parts.join("\n")}`,
          },
        ],
        max_tokens: 100,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the current git branch name for a directory.
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      return text.trim();
    }
  } catch {
    // not a git repo
  }
  return null;
}

/**
 * Get recently modified tracked files in the git repo.
 */
export async function getRecentFiles(
  cwd: string,
  limit = 10
): Promise<string[]> {
  try {
    // Get modified/staged files first
    const diffProc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const diffText = await new Response(diffProc.stdout).text();
    await diffProc.exited;

    const files = diffText
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    if (files.length >= limit) {
      return files.slice(0, limit);
    }

    // Also get recently committed files
    const logProc = Bun.spawn(
      ["git", "log", "--oneline", "--name-only", "-5", "--format="],
      {
        cwd,
        stdout: "pipe",
        stderr: "ignore",
      }
    );
    const logText = await new Response(logProc.stdout).text();
    await logProc.exited;

    const logFiles = logText
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    const allFiles = [...new Set([...files, ...logFiles])];
    return allFiles.slice(0, limit);
  } catch {
    return [];
  }
}
