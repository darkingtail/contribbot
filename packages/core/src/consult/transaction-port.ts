/** Synchronous exclusive transaction boundary supplied by the composition root. */
export interface SynchronousTransactionPort {
  run<T>(operation: () => T): T
}
