/** Runs each piece of work it is given once the one before has settled, failed or not, in the order given. */
export type Serial = <A>(work: () => Promise<A>) => Promise<A>;

export const serial = (): Serial => {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const run = tail.then(work);
    tail = run.catch(() => {});
    return run;
  };
};
