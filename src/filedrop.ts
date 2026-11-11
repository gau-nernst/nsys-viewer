/** True when a drag carries files from the OS, not an in-page drag such as reordering device rows. */
export function isFileDrag(types: ArrayLike<string> | null | undefined): boolean {
  return !!types && Array.prototype.includes.call(types, "Files");
}

/**
 * Whether a file drag is over the window. dragenter / dragleave fire for every element the pointer
 * crosses, so a single dragleave does not mean the drag left the window: count them instead.
 */
export class FileDragDepth {
  private depth = 0;

  enter(): boolean {
    this.depth += 1;
    return true;
  }

  leave(): boolean {
    this.depth = Math.max(0, this.depth - 1);
    return this.depth > 0;
  }

  reset(): void {
    this.depth = 0;
  }
}
