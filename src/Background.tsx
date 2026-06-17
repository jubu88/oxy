import { useEffect, useRef } from "react";

// Animated WebGL nebula background (origin: a Google Stitch generation). A slow
// drifting slate nebula with indigo/cyan glow cores, a faint grid, and slow
// particles — tuned to sit BEHIND the solid UI panels so it shows in the margins
// without hurting contrast. Derivative-free + int loop so it compiles on every GL
// backend; no context loss on StrictMode remount. Degrades to the dark html
// fallback if WebGL is unavailable.
const VERT = `attribute vec2 a_position;
varying vec2 v_texCoord;
void main(){ v_texCoord = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;

const FRAG = `precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
varying vec2 v_texCoord;
float noise(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec2 uv = v_texCoord;
  vec2 p = uv - 0.5;
  p.x *= u_resolution.x / u_resolution.y;
  vec3 color1 = vec3(0.05, 0.07, 0.14);   // slate (~brand-slate)
  vec3 color2 = vec3(0.10, 0.07, 0.20);   // violet-slate
  float drift = u_time * 0.05;
  float mask = smoothstep(0.1, 0.9, sin(uv.x * 2.0 + drift) * 0.5 + 0.5);
  vec3 nebula = mix(color1, color2, mask);
  // two slow drifting glow cores: indigo (#6366F1) + cyan
  nebula += vec3(0.39, 0.40, 0.95) * (0.13 / (length(p - vec2(sin(drift), cos(drift)) * 0.35) + 0.60));
  nebula += vec3(0.10, 0.55, 0.85) * (0.10 / (length(p - vec2(cos(drift * 0.8), sin(drift * 0.7)) * 0.42) + 0.65));
  // faint drifting grid (derivative-free)
  vec2 g = uv * 34.0; g.y += u_time * 0.18;
  vec2 gf = abs(fract(g - 0.5) - 0.5);
  float line = 1.0 - smoothstep(0.0, 0.05, min(gf.x, gf.y));
  nebula += vec3(0.30, 0.34, 0.85) * line * 0.03;
  // slow particles
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    vec2 pos = vec2(noise(vec2(fi, 1.0)), noise(vec2(fi, 2.0)));
    pos.y = fract(pos.y - u_time * 0.02);
    float d = length(uv - pos);
    nebula += vec3(0.4, 0.5, 1.0) * 0.0012 / (d + 0.006);
  }
  gl_FragColor = vec4(nebula, 1.0);
}`;

export function Background() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = (canvas.getContext("webgl", { preserveDrawingBuffer: true }) || canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn("[oxy bg] shader compile failed:", gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("[oxy bg] program link failed:", gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    const uTime = gl.getUniformLocation(prog, "u_time");
    const uRes = gl.getUniformLocation(prog, "u_resolution");
    let raf = 0;
    const resize = () => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    const render = (t: number) => {
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(uTime, t * 0.001);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    // only stop the loop on cleanup — do NOT lose the context (StrictMode remount)
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="bg-canvas" aria-hidden="true" />;
}
