import { Scheduler } from "effect";

/**
 * Effect's scheduler for a simulation: the batches of work fibers hand it wait until the driver runs them
 * (`runOne`), rather than for the event loop's next turn, so the driver knows when nothing is left to run and decides
 * what runs next. Each fiber batches its own work, in order; which fiber's batch runs first is the driver's choice
 * (`choose`), as Effect promises no order between fibers.
 */
export class SimScheduler {
  readonly scheduler: Scheduler.Scheduler;
  private readonly ready: (() => void)[] = [];
  private readonly choose: (count: number) => number;

  /** `choose(count)` picks which of `count` waiting batches runs next; the oldest by default. */
  constructor(choose: (count: number) => number = () => 0) {
    this.choose = choose;
    this.scheduler = new Scheduler.MixedScheduler("async", (run) => {
      this.ready.push(run);
      return () => {
        const index = this.ready.indexOf(run);
        if (index >= 0) this.ready.splice(index, 1);
      };
    });
  }

  /** Batches waiting to run. */
  get runnable(): number {
    return this.ready.length;
  }

  /** Runs one waiting batch; false when there was none. */
  runOne(): boolean {
    if (this.ready.length === 0) return false;
    const [run] = this.ready.splice(this.choose(this.ready.length), 1);
    run!();
    return true;
  }
}
