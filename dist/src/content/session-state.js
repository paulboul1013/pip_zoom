export class PiPSessionState {
  #mode = 'selecting';

  get isSelectionEnabled() {
    return this.#mode === 'selecting';
  }

  get isDestroyed() {
    return this.#mode === 'destroyed';
  }

  get isPiPActive() {
    return this.#mode === 'pip-active';
  }

  activatePiP() {
    if (this.#mode !== 'selecting') {
      throw new Error('PiP can only be activated while selecting a region');
    }
    this.#mode = 'pip-active';
  }

  closePiP() {
    if (this.#mode === 'pip-active') {
      this.#mode = 'destroyed';
    }
  }

  cancel() {
    this.#mode = 'destroyed';
  }
}
