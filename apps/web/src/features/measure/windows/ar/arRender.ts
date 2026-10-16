import type { ArPoint } from '@roofline/shared';
import { multiply } from './arMath.ts';
import type { XrCamera, XrMatrix } from './xr.ts';

/*
 * The AR view's drawing, raw WebGL (no 3D library): the aim reticle (a ring lying on the surface the hit-test found),
 * the corners placed so far as dots, and the frame's sides as lines (the open side follows the reticle). The camera
 * picture itself is drawn by the browser underneath (immersive-ar composites the camera), so only lines are drawn.
 */

const VERTEX = `
attribute vec3 position;
uniform mat4 viewProjection;
uniform float pointSize;
void main() {
  gl_Position = viewProjection * vec4(position, 1.0);
  gl_PointSize = pointSize;
}`;
const FRAGMENT = `
precision mediump float;
uniform vec4 color;
void main() { gl_FragColor = color; }`;

export type DrawView = { viewport: { x: number; y: number; width: number; height: number }; projectionMatrix: XrMatrix; viewMatrix: XrMatrix };
export type DrawScene = { points: readonly ArPoint[]; aim: ArPoint | null; reticle: XrMatrix | null };

export type ArRenderer = { draw: (framebuffer: WebGLFramebuffer | null, views: readonly DrawView[], scene: DrawScene) => void; dispose: () => void };

const RING: [number, number][] = Array.from({ length: 32 }, (_, i) => [Math.cos((i / 32) * Math.PI * 2) * 0.04, Math.sin((i / 32) * Math.PI * 2) * 0.04]);

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (s === null) return null;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
}

/** Null when the shaders do not compile (the overlay still works; only the lines are missing). */
export function createRenderer(gl: WebGLRenderingContext): ArRenderer | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (vs === null || fs === null || program === null) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const buffer = gl.createBuffer();
  const aPosition = gl.getAttribLocation(program, 'position');
  const uViewProjection = gl.getUniformLocation(program, 'viewProjection');
  const uColor = gl.getUniformLocation(program, 'color');
  const uPointSize = gl.getUniformLocation(program, 'pointSize');

  const shape = (mode: number, vertices: number[], color: [number, number, number, number], size = 1) => {
    if (vertices.length === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.uniform4fv(uColor, color);
    gl.uniform1f(uPointSize, size);
    gl.drawArrays(mode, 0, vertices.length / 3);
  };

  return {
    draw(framebuffer, views, scene) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(program);
      // The ring in the hit pose's x-z plane (its y axis is the surface normal)
      const ring: number[] = [];
      if (scene.reticle !== null) {
        const m = scene.reticle;
        for (const [a, b] of RING) ring.push(m[0]! * a + m[8]! * b + m[12]!, m[1]! * a + m[9]! * b + m[13]!, m[2]! * a + m[10]! * b + m[14]!);
      }
      const path = [...scene.points, ...(scene.points.length < 4 && scene.aim !== null && scene.points.length > 0 ? [scene.aim] : [])];
      if (scene.points.length === 4) path.push(scene.points[0]!);
      for (const view of views) {
        const { x, y, width, height } = view.viewport;
        gl.viewport(x, y, width, height);
        gl.uniformMatrix4fv(uViewProjection, false, new Float32Array(multiply(view.projectionMatrix, view.viewMatrix)));
        shape(gl.LINE_LOOP, ring, [1, 1, 1, 0.95]);
        shape(gl.LINE_STRIP, path.flat(), [1, 0.8, 0.1, 1]);
        shape(gl.POINTS, scene.points.flat(), [1, 0.8, 0.1, 1], 18);
      }
    },
    dispose() {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

/** WebXR Raw Camera Access: the binding that hands out the camera picture for a view (Chrome on Android). */
export type CameraBinding = { getCameraImage: (camera: XrCamera) => WebGLTexture | null };

/**
 * The camera picture of this frame as a 2D canvas, read back from the opaque camera texture (only valid inside the XR
 * frame callback). Null when the texture cannot be read (the browser may refuse to attach it to a framebuffer).
 */
export function readCameraImage(gl: WebGLRenderingContext, binding: CameraBinding, camera: XrCamera, restore: WebGLFramebuffer | null): HTMLCanvasElement | null {
  const texture = binding.getCameraImage(camera);
  if (texture === null) return null;
  const fb = gl.createFramebuffer();
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    const { width, height } = camera;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    const image = ctx.createImageData(width, height);
    // GL rows run bottom-up
    const row = width * 4;
    for (let y = 0; y < height; y++) image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    ctx.putImageData(image, 0, 0);
    return canvas;
  } catch {
    return null;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, restore);
    gl.deleteFramebuffer(fb);
  }
}
