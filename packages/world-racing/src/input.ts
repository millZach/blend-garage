import type {
  DriveInputActions,
  DriveInputFrame,
  DriveInputOptions,
  GamepadLike,
  InputSource,
  VehicleControlInput,
} from './types.js';

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function shapeStickAxis(raw: number, deadzone: number, exponent: number): number {
  const abs = Math.abs(raw);
  if (abs <= deadzone) return 0;
  const normalized = clamp((abs - deadzone) / (1 - deadzone), 0, 1);
  return Math.sign(raw) * Math.pow(normalized, exponent);
}

function shapeTrigger(raw: number, deadzone: number): number {
  if (!Number.isFinite(raw) || raw <= deadzone) return 0;
  return clamp((raw - deadzone) / (1 - deadzone), 0, 1);
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

const DEFAULT_ACTIONS: DriveInputActions = {
  repair: false,
  reset: false,
  cycleCamera: false,
  toggleHeadlights: false,
  exitDrive: false,
  toggleTransmission: false,
};

/**
 * Pure TypeScript driving input controller unifying Keyboard (WASD + Arrows + hotkeys)
 * and W3C Gamepad API (Xbox / PlayStation controllers + dual-rumble vibration).
 */
export class DriveInputController {
  private readonly stickDeadzone: number;
  private readonly steerExponent: number;
  private readonly triggerDeadzone: number;
  private readonly keyboardSteerRate: number;
  private readonly keyboardSteerReturnRate: number;
  private readonly getGamepadsFn: () => readonly (GamepadLike | null)[];

  private readonly pressedKeys = new Set<string>();
  private readonly pendingActions: DriveInputActions = { ...DEFAULT_ACTIONS };
  private pendingShift: -1 | 0 | 1 = 0;

  private keyboardSteer = 0;
  private activeSource: InputSource = 'keyboard';
  private gamepadName: string | null = null;
  private gamepadConnected = false;
  private prevGamepadButtons: boolean[] = [];

  private target: Window | null = null;
  private readonly onKeyDownBound: (e: KeyboardEvent) => void;
  private readonly onKeyUpBound: (e: KeyboardEvent) => void;
  private readonly onBlurBound: () => void;
  private readonly onGamepadConnectedBound: (e: GamepadEvent) => void;
  private readonly onGamepadDisconnectedBound: () => void;

  constructor(options: DriveInputOptions = {}) {
    this.stickDeadzone = clamp(options.stickDeadzone ?? 0.12, 0, 0.45);
    this.steerExponent = clamp(options.steerExponent ?? 1.55, 1, 3);
    this.triggerDeadzone = clamp(options.triggerDeadzone ?? 0.05, 0, 0.3);
    this.keyboardSteerRate = options.keyboardSteerRate ?? 5.5;
    this.keyboardSteerReturnRate = options.keyboardSteerReturnRate ?? 7.5;
    this.getGamepadsFn =
      options.getGamepads
      ?? (() => {
        if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
          return navigator.getGamepads();
        }
        return [];
      });

    this.onKeyDownBound = (e) => this.handleKeyDown(e);
    this.onKeyUpBound = (e) => this.handleKeyUp(e);
    this.onBlurBound = () => this.clearKeyboardState();
    this.onGamepadConnectedBound = (e) => {
      this.gamepadConnected = true;
      this.gamepadName = e.gamepad?.id || 'Controller';
      this.activeSource = 'gamepad';
    };
    this.onGamepadDisconnectedBound = () => {
      this.refreshGamepadStatus();
      if (!this.gamepadConnected) {
        this.activeSource = 'keyboard';
      }
    };
  }

  attach(target?: Window): void {
    const win = target ?? (typeof window !== 'undefined' ? window : null);
    if (!win || this.target === win) return;
    this.detach();
    this.target = win;
    win.addEventListener('keydown', this.onKeyDownBound);
    win.addEventListener('keyup', this.onKeyUpBound);
    win.addEventListener('blur', this.onBlurBound);
    win.addEventListener('gamepadconnected', this.onGamepadConnectedBound as EventListener);
    win.addEventListener('gamepaddisconnected', this.onGamepadDisconnectedBound);
    this.refreshGamepadStatus();
  }

  detach(): void {
    if (!this.target) return;
    this.target.removeEventListener('keydown', this.onKeyDownBound);
    this.target.removeEventListener('keyup', this.onKeyUpBound);
    this.target.removeEventListener('blur', this.onBlurBound);
    this.target.removeEventListener('gamepadconnected', this.onGamepadConnectedBound as EventListener);
    this.target.removeEventListener('gamepaddisconnected', this.onGamepadDisconnectedBound);
    this.target = null;
    this.clearKeyboardState();
  }

  dispose(): void {
    this.detach();
  }

  /** Programmatic key state injection (useful for unit tests and on-screen controls). */
  setKeyState(code: string, pressed: boolean): void {
    const wasDown = this.pressedKeys.has(code);
    if (pressed) {
      this.pressedKeys.add(code);
      this.activeSource = 'keyboard';
      if (!wasDown) {
        this.triggerKeyboardEdgeAction(code);
      }
    } else {
      this.pressedKeys.delete(code);
    }
  }

  clearKeyboardState(): void {
    this.pressedKeys.clear();
    this.keyboardSteer = 0;
  }

  getActiveSource(): InputSource {
    return this.activeSource;
  }

  getGamepadName(): string | null {
    return this.gamepadName;
  }

  /** Triggers dual-rumble haptic feedback on the active controller when supported. */
  triggerRumble(intensity: number, durationMs = 140): void {
    const pad = this.findActiveGamepad();
    const actuator = pad?.vibrationActuator;
    if (!actuator || typeof actuator.playEffect !== 'function') return;

    const clamped = clamp(intensity, 0, 1);
    const duration = clamp(durationMs, 25, 1200);
    try {
      void actuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration,
        weakMagnitude: clamped * 0.7,
        strongMagnitude: clamped,
      });
    } catch {
      // Some browsers reject vibration when tab is unfocused or without user gesture; ignore safely.
    }
  }

  /** Samples keyboard + gamepad inputs for the current frame and consumes one-shot actions. */
  poll(dtSeconds = 1 / 60): DriveInputFrame {
    const dt = clamp(dtSeconds, 1 / 240, 0.1);
    const actions: DriveInputActions = { ...this.pendingActions };
    this.pendingActions.repair = false;
    this.pendingActions.reset = false;
    this.pendingActions.cycleCamera = false;
    this.pendingActions.toggleHeadlights = false;
    this.pendingActions.exitDrive = false;
    this.pendingActions.toggleTransmission = false;

    let shift: -1 | 0 | 1 = this.pendingShift;
    this.pendingShift = 0;

    // 1. Sample keyboard continuous controls
    const kbThrottle = this.isAnyKeyDown('KeyW', 'ArrowUp') ? 1 : 0;
    const kbBrake = this.isAnyKeyDown('KeyS', 'ArrowDown') ? 1 : 0;
    const kbLeft = this.isAnyKeyDown('KeyA', 'ArrowLeft');
    const kbRight = this.isAnyKeyDown('KeyD', 'ArrowRight');
    const kbHandbrake = this.pressedKeys.has('Space');

    const kbSteerTarget = (kbRight ? 1 : 0) - (kbLeft ? 1 : 0);
    if (kbSteerTarget !== 0) {
      // Smoothly ramp keyboard steering for natural feel without jerky snaps
      const rate = Math.sign(kbSteerTarget) !== Math.sign(this.keyboardSteer) && this.keyboardSteer !== 0
        ? this.keyboardSteerReturnRate * 1.4
        : this.keyboardSteerRate;
      this.keyboardSteer = clamp(this.keyboardSteer + kbSteerTarget * rate * dt, -1, 1);
    } else if (Math.abs(this.keyboardSteer) > 1e-4) {
      const drop = this.keyboardSteerReturnRate * dt;
      this.keyboardSteer =
        Math.abs(this.keyboardSteer) <= drop
          ? 0
          : this.keyboardSteer - Math.sign(this.keyboardSteer) * drop;
    }

    const kbActive = kbThrottle > 0 || kbBrake > 0 || kbLeft || kbRight || kbHandbrake;
    if (kbActive) {
      this.activeSource = 'keyboard';
    }

    // 2. Sample W3C standard Gamepad
    let gpThrottle = 0;
    let gpBrake = 0;
    let gpSteer = 0;
    let gpHandbrake = false;

    const pad = this.findActiveGamepad();
    if (pad) {
      this.gamepadConnected = true;
      this.gamepadName = pad.id || 'Controller';

      const rawAxisX = pad.axes[0] ?? 0;
      gpSteer = shapeStickAxis(rawAxisX, this.stickDeadzone, this.steerExponent);

      // RT/R2 = button 7, LT/L2 = button 6
      gpThrottle = shapeTrigger(pad.buttons[7]?.value ?? (pad.buttons[7]?.pressed ? 1 : 0), this.triggerDeadzone);
      gpBrake = shapeTrigger(pad.buttons[6]?.value ?? (pad.buttons[6]?.pressed ? 1 : 0), this.triggerDeadzone);

      // A/Cross (0), B/Circle (1), or X/Square (2) -> handbrake
      gpHandbrake = Boolean(
        pad.buttons[0]?.pressed || pad.buttons[1]?.pressed || pad.buttons[2]?.pressed,
      );

      // Edge-triggered gamepad buttons
      const wasPressed = (idx: number) => Boolean(this.prevGamepadButtons[idx]);
      const isPressed = (idx: number) => Boolean(pad.buttons[idx]?.pressed);
      const justPressed = (idx: number) => isPressed(idx) && !wasPressed(idx);

      if (justPressed(3)) actions.cycleCamera = true; // Y / Triangle
      if (justPressed(4)) shift = -1; // LB / L1 shift down
      if (justPressed(5)) shift = 1; // RB / R1 shift up
      if (justPressed(8)) actions.repair = true; // Back / Select / Share
      if (justPressed(9)) actions.exitDrive = true; // Start / Options
      if (justPressed(10) || justPressed(12)) actions.reset = true; // L3 or D-Pad Up -> Reset to Road
      if (justPressed(13) || justPressed(15)) actions.toggleHeadlights = true; // D-Pad Down/Right
      if (justPressed(14)) actions.toggleTransmission = true; // D-Pad Left

      let anyGpButton = false;
      const nextPrev: boolean[] = [];
      for (let i = 0; i < pad.buttons.length; i++) {
        const down = Boolean(pad.buttons[i]?.pressed);
        nextPrev[i] = down;
        if (down) anyGpButton = true;
      }
      this.prevGamepadButtons = nextPrev;

      if (gpThrottle > 0 || gpBrake > 0 || Math.abs(gpSteer) > 0 || anyGpButton) {
        this.activeSource = 'gamepad';
      }
    } else {
      this.gamepadConnected = false;
      this.gamepadName = null;
      this.prevGamepadButtons = [];
    }

    // 3. Merge keyboard + gamepad seamlessly (whichever is providing stronger input wins)
    const throttle = Math.max(kbThrottle, gpThrottle);
    const brake = Math.max(kbBrake, gpBrake);
    const steer = Math.abs(gpSteer) >= Math.abs(this.keyboardSteer) ? gpSteer : this.keyboardSteer;
    const handbrake = kbHandbrake || gpHandbrake;

    const control: VehicleControlInput = {
      throttle,
      brake,
      steer,
      handbrake,
      shift,
    };

    return {
      control,
      actions,
      activeSource: this.activeSource,
      gamepadName: this.gamepadName,
      gamepadConnected: this.gamepadConnected,
    };
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (isEditableElement(e.target)) return;
    if (
      e.code === 'Space'
      || e.code === 'ArrowUp'
      || e.code === 'ArrowDown'
      || e.code === 'ArrowLeft'
      || e.code === 'ArrowRight'
    ) {
      e.preventDefault();
    }
    this.setKeyState(e.code, true);
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.setKeyState(e.code, false);
  }

  private triggerKeyboardEdgeAction(code: string): void {
    switch (code) {
      case 'KeyR':
        this.pendingActions.repair = true;
        break;
      case 'KeyT':
        this.pendingActions.reset = true;
        break;
      case 'KeyC':
        this.pendingActions.cycleCamera = true;
        break;
      case 'KeyH':
        this.pendingActions.toggleHeadlights = true;
        break;
      case 'Escape':
        this.pendingActions.exitDrive = true;
        break;
      case 'KeyM':
        this.pendingActions.toggleTransmission = true;
        break;
      case 'KeyE':
      case 'ShiftLeft':
      case 'ShiftRight':
        this.pendingShift = 1;
        break;
      case 'KeyQ':
      case 'ControlLeft':
      case 'ControlRight':
        this.pendingShift = -1;
        break;
    }
  }

  private isAnyKeyDown(...codes: string[]): boolean {
    for (const c of codes) {
      if (this.pressedKeys.has(c)) return true;
    }
    return false;
  }

  private findActiveGamepad(): GamepadLike | null {
    const pads = this.getGamepadsFn();
    for (const pad of pads) {
      if (pad && pad.connected !== false) {
        return pad;
      }
    }
    return null;
  }

  private refreshGamepadStatus(): void {
    const pad = this.findActiveGamepad();
    this.gamepadConnected = Boolean(pad);
    this.gamepadName = pad ? pad.id || 'Controller' : null;
  }
}
