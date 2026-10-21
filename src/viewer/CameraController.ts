import * as THREE from "three";
import { SparkControls, SparkXr } from "@sparkjsdev/spark";
import type { SplatBounds, LocomotionMode } from "./types";
import { WalkController } from "./WalkController";
import { TeleportController } from "./TeleportController";
import {
  CAMERA_FOV,
  RESET_ANIMATION_MS,
  XR_MODE,
} from "../config";

/**
 * Manages camera controls (SparkControls), WebXR (SparkXr),
 * walk/fly mode toggle, VR teleportation, and the reset-view animation.
 */
export class CameraController {
  readonly controls: SparkControls;
  readonly xr: SparkXr;
  readonly walkController: WalkController;
  readonly teleportController: TeleportController;

  private bounds: SplatBounds | null = null;
  private renderer: THREE.WebGLRenderer;

  /** Current locomotion mode */
  private _mode: LocomotionMode = "fly";
  get mode(): LocomotionMode {
    return this._mode;
  }

  /** Whether collision mesh is available (walk mode possible) */
  private collisionReady = false;

  /** Fly-mode movement speed (stored to restore when switching back) */
  private flyMoveSpeed = 1;

  // Reset-view animation state
  private resetStartPos = new THREE.Vector3();
  private resetEndPos = new THREE.Vector3();
  private resetStartQuat = new THREE.Quaternion();
  private resetEndQuat = new THREE.Quaternion();
  private resetProgress = -1; // < 0 means not animating
  private resetDuration = RESET_ANIMATION_MS / 1000;

  private vrButtonContainer: HTMLElement | null = null;

  /** Saved pre-update position for walk mode physics */
  private _prevPos = new THREE.Vector3();

  /** Callback when mode changes */
  onModeChange?: (mode: LocomotionMode) => void;

  constructor(
    canvas: HTMLCanvasElement,
    renderer: THREE.WebGLRenderer
  ) {
    this.renderer = renderer;
    this.walkController = new WalkController();
    this.teleportController = new TeleportController();

    // Spark controls: WASD + mouse/touch + scroll + gamepad
    this.controls = new SparkControls({ canvas });

    // Invert WASD/arrow movement — Spark defaults assume -Z forward but
    // this scene's coordinate convention has +Z forward.
    const move = this.controls.fpsMovement.keycodeMoveMapping;
    move["KeyW"] = new THREE.Vector3(0, 0, 1);
    move["ArrowUp"] = new THREE.Vector3(0, 0, 1);
    move["KeyS"] = new THREE.Vector3(0, 0, -1);
    move["ArrowDown"] = new THREE.Vector3(0, 0, -1);
    move["KeyA"] = new THREE.Vector3(1, 0, 0);
    move["ArrowLeft"] = new THREE.Vector3(1, 0, 0);
    move["KeyD"] = new THREE.Vector3(-1, 0, 0);
    move["ArrowRight"] = new THREE.Vector3(-1, 0, 0);

    // Remap Q/E from roll to vertical movement
    move["KeyQ"] = new THREE.Vector3(0, -1, 0); // down
    move["KeyE"] = new THREE.Vector3(0, 1, 0);  // up
    delete this.controls.fpsMovement.keycodeRotateMapping["KeyQ"];
    delete this.controls.fpsMovement.keycodeRotateMapping["KeyE"];

    // Wire up XR controller sticks to FpsMovement
    this.controls.fpsMovement.xr = renderer.xr;

    // Create VR button container
    this.vrButtonContainer = document.createElement("div");
    this.vrButtonContainer.id = "vr-button-container";
    canvas.parentElement?.appendChild(this.vrButtonContainer);

    // WebXR support — button auto-shown on platforms that support XR.
    // IMPORTANT: SparkXr's initializeXr() sets renderer.xr.enabled = true
    // as soon as it detects browser XR support, even before any session is
    // entered. This puts Three.js into its XR rendering path and causes
    // flickering on non-XR views. We counteract this in onReady by
    // resetting it to false, then only enabling it when actually entering XR.
    this.xr = new SparkXr({
      renderer,
      element: this.vrButtonContainer,
      mode: XR_MODE,
      allowMobileXr: true,
      
onReady: (supported: boolean) => {
  console.log("[VR Debug] WebXR supported:", supported);
  renderer.xr.enabled = false;

  const container = this.vrButtonContainer;
  if (!container || container.querySelector("button")) return;

  // Create our own button instead of relying on SparkXr to insert one.
  const button = document.createElement("button");
  button.textContent = "Enter VR";

  Object.assign(button.style, {
    padding: "12px 20px",
    margin: "8px",
    border: "0",
    borderRadius: "8px",
    background: "#1769ff",
    color: "white",
    fontSize: "16px",
    fontWeight: "bold",
    cursor: "pointer",
  });

  button.addEventListener("click", async () => {
    try {
      const xr = (navigator as any).xr;

      if (!xr) {
        throw new Error("WebXR is unavailable in this browser.");
      }

      const canEnterVR = await xr.isSessionSupported("immersive-vr");
      if (!canEnterVR) {
        throw new Error("Immersive VR is not supported on this device.");
      }

      button.disabled = true;
      button.textContent = "Starting VR…";

      const session = await xr.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking"],
      });

      session.addEventListener("end", () => {
        renderer.xr.enabled = false;
        button.disabled = false;
        button.textContent = "Enter VR";
      });

      renderer.xr.enabled = true;
      await renderer.xr.setSession(session);

      if (this.collisionReady && this._mode !== "walk") {
        this.setMode("walk");
      }

      button.textContent = "Exit VR";
      button.disabled = false;
      button.onclick = async () => {
        await session.end();
      };
    } catch (error) {
      console.error("[VR Debug] Failed to enter VR:", error);
      button.textContent = "Enter VR";
      button.disabled = false;
    }
  });

  container.appendChild(button);
},

      onEnterXr: () => {
        renderer.xr.enabled = true;
        // In XR, always use walk mode if collision mesh is ready
        if (this.collisionReady && this._mode !== "walk") {
          this.setMode("walk");
        }
      },
      onExitXr: () => {
        renderer.xr.enabled = false;
      },
    });

    // Listen for mode toggle key (Tab)
    document.addEventListener("keydown", this._onKeyDown);
  }

  private _onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Tab" && this.collisionReady) {
      e.preventDefault();
      this.toggleMode();
    }
  };

  /** Set bounds after splat loads — used for reset view and movement speed */
  setBounds(bounds: SplatBounds): void {
    this.bounds = bounds;

    // Scale movement speed to scene size so WASD feels responsive
    this.flyMoveSpeed = bounds.radius * 0.5;
    this.controls.fpsMovement.moveSpeed = this.flyMoveSpeed;
  }

  /**
   * Set the collision mesh — enables walk mode.
   */
  setCollisionMesh(mesh: THREE.Mesh): void {
    this.collisionReady = true;
    this.walkController.setCollisionMesh(mesh);
    this.teleportController.setCollisionMesh(mesh);
  }

  /**
   * Toggle between fly and walk modes.
   */
  toggleMode(localFrame?: THREE.Group): void {
    if (!this.collisionReady) return;

    if (this._mode === "fly") {
      this.setMode("walk", localFrame);
    } else {
      this.setMode("fly");
    }
  }

  /**
   * Set locomotion mode explicitly.
   */
  setMode(mode: LocomotionMode, localFrame?: THREE.Group): void {
    if (mode === this._mode) return;
    this._mode = mode;

    if (mode === "walk") {
      // Reduce move speed for walk mode (WalkController clamps further)
      this.controls.fpsMovement.moveSpeed = this.flyMoveSpeed * 0.5;
      // Snap to floor if localFrame provided
      if (localFrame) {
        this.walkController.snapToFloor(localFrame);
      }
    } else {
      // Restore fly speed
      this.controls.fpsMovement.moveSpeed = this.flyMoveSpeed;
    }

    this.onModeChange?.(mode);
  }

  /**
   * Update controls each frame.
   * Call this in the animation loop.
   */
  update(localFrame: THREE.Group, camera: THREE.Camera, deltaTime: number): void {
    // Save position before SparkControls moves it (for walk mode)
    this._prevPos.copy(localFrame.position);

    // Update XR controllers first (moves localFrame via stick input)
    this.xr.updateControllers(camera);

    // Update SparkControls (keyboard, mouse, touch, gamepad)
    this.controls.update(localFrame, camera);

    // ── Walk mode physics (post-process position) ──
    if (this._mode === "walk" && this.collisionReady) {
      this.walkController.update(localFrame, this._prevPos, deltaTime);
    }

    // ── VR teleportation + snap turn ──
    const session = this.renderer.xr.getSession();
    if (session && this.collisionReady) {
      const snapDelta = this.teleportController.update(
        this.renderer,
        localFrame,
        camera
      );
      if (snapDelta !== 0) {
        // Apply snap turn to localFrame quaternion
        const snapQuat = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          snapDelta
        );
        localFrame.quaternion.premultiply(snapQuat);
      }
    }

    // Animate reset view if active
    if (this.resetProgress >= 0) {
      this.resetProgress += deltaTime / this.resetDuration;
      if (this.resetProgress >= 1) {
        this.resetProgress = -1;
        localFrame.position.copy(this.resetEndPos);
        localFrame.quaternion.copy(this.resetEndQuat);
      } else {
        // Smooth ease-out interpolation
        const t = 1 - Math.pow(1 - this.resetProgress, 3);
        localFrame.position.lerpVectors(this.resetStartPos, this.resetEndPos, t);
        localFrame.quaternion.slerpQuaternions(
          this.resetStartQuat,
          this.resetEndQuat,
          t
        );
      }
    }
  }

  /**
   * Animate camera to the ideal position to view the entire splat.
   */
  resetView(localFrame: THREE.Group): void {
    if (!this.bounds) return;

    const fovRad = THREE.MathUtils.degToRad(CAMERA_FOV);
    const idealDistance = this.bounds.radius / Math.tan(fovRad / 2);

    // Start from current position/rotation
    this.resetStartPos.copy(localFrame.position);
    this.resetStartQuat.copy(localFrame.quaternion);

    // End position: look at center from current direction, at ideal distance
    const currentDir = new THREE.Vector3(0, 0, -1);
    currentDir.applyQuaternion(localFrame.quaternion);

    // Position localFrame so camera ends up at idealDistance from center
    // Since camera is at (0,0,0) relative to localFrame in default setup,
    // place localFrame at center + direction * idealDistance
    this.resetEndPos
      .copy(this.bounds.center)
      .sub(currentDir.multiplyScalar(idealDistance));

    // Keep current orientation but look at center
    this.resetEndQuat.copy(localFrame.quaternion);

    this.resetProgress = 0;
  }

  dispose(): void {
    document.removeEventListener("keydown", this._onKeyDown);
    if (this.vrButtonContainer) {
      this.vrButtonContainer.remove();
    }
    this.walkController.dispose();
    this.teleportController.dispose();
  }
}
