import type { Interface } from "node:readline/promises";

/**
 * rl.question() that also settles when input ends.
 *
 * At end of input (Ctrl-D, a closed pipe) readline closes and the pending
 * question never resolves. Nothing is left to keep the process alive, so it
 * exits 0 without running whatever came after the prompt, including the
 * "Aborted" branch and its exit code. Null means the input ended.
 */
export function ask(rl: Interface, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const onClose = () => resolve(null);
    rl.once("close", onClose);
    rl.question(prompt).then(
      (answer) => {
        rl.off("close", onClose);
        resolve(answer);
      },
      () => resolve(null),
    );
  });
}
