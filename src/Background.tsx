import { useEffect, useRef } from "react";

// Animated WebGL nebula background — adapted from the Google Stitch generation
// (design/stitch-ui.html): a drifting aurora/nebula with a faint grid and slow
// particles. Runs behind the whole UI. Degrades to a static dark backdrop if
// WebGL is unavailable.
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
  vec3 color1 = vec3(0.06, 0.11, 0.26);    // navy
  vec3 color2 = vec3(0.20, 0.07, 0.38);    // violet
  vec3 accent = vec3(0.0, 0.62, 0.95);     // cyan glow
  float drift = u_time * 0.05;
  float mask = smoothstep(0.1, 0.9, sin(uv.x * 2.0 + drift) * 0.5 + 0.5);
  vec3 nebula = mix(color1, color2, mask);
  // two slow drifting glow cores (cyan + violet)
  nebula += accent * (0.24 / (length(p - vec2(sin(drift), cos(drift)) * 0.35) + 0.55));
  nebula += vec3(0.5, 0.22, 1.0) * (0.18 / (length(p - vec2(cos(drift * 0.8), sin(drift * 0.7)) * 0.4) + 0.6));
  // drifting grid (derivative-free, so it renders on every GL backend)
  vec2 g = uv * 34.0; g.y += u_time * 0.18;
  vec2 gf = abs(fract(g - 0.5) - 0.5);
  float line = 1.0 - smoothstep(0.0, 0.045, min(gf.x, gf.y));
  nebula += vec3(0.12, 0.6, 0.9) * line * 0.05;
  // slow particles
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    vec2 pos = vec2(noise(vec2(fi, 1.0)), noise(vec2(fi, 2.0)));
    pos.y = fract(pos.y - u_time * 0.025);
    float d = length(uv - pos);
    nebula += vec3(0.3, 0.75, 1.0) * 0.0016 / (d + 0.006);
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
    // Only stop the loop on cleanup — do NOT lose the context. Under React
    // StrictMode the effect runs twice (mount → cleanup → mount); getContext
    // returns the SAME context on remount, so losing it here would leave the
    // second mount drawing onto a dead context (a blank canvas).
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="bg-canvas" aria-hidden="true" />;
}
