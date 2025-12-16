import React, { useRef, useEffect, useState } from 'react';
import { RobotSpecs, Position, MotorAngles, SimulationPath } from '../types';
import { MOTOR_OFFSET_ANGLES } from '../constants';
import { RotateCcw, Eye, EyeOff, Sun } from 'lucide-react';

interface DeltaVisualizerProps {
  specs: RobotSpecs;
  position: Position; // This is now TIP position
  angles: MotorAngles;
  simPath?: SimulationPath;
  playbackIndex: number;
}

const DeltaVisualizer: React.FC<DeltaVisualizerProps> = ({ specs, position, angles, simPath, playbackIndex }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Camera State
  const [camera, setCamera] = useState({
    yaw: Math.PI / 4,   
    pitch: Math.PI / 3, 
    zoom: 0.8,
    panX: 0,
    panY: 0
  });

  const [showGhost, setShowGhost] = useState(true);
  const [showLighting, setShowLighting] = useState(true);

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragMode, setDragMode] = useState<'rotate' | 'pan'>('rotate');

  const resetView = () => {
    setCamera({
      yaw: Math.PI / 4,
      pitch: Math.PI / 3,
      zoom: 0.8,
      panX: 0,
      panY: 0
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setDragMode(e.shiftKey || e.button === 2 ? 'pan' : 'rotate');
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;

    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;

    if (dragMode === 'rotate') {
      setCamera(prev => ({
        ...prev,
        yaw: prev.yaw - dx * 0.01,
        pitch: Math.max(0.1, Math.min(Math.PI - 0.1, prev.pitch - dy * 0.01))
      }));
    } else {
      setCamera(prev => ({
        ...prev,
        panX: prev.panX + dx,
        panY: prev.panY + dy
      }));
    }

    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => setIsDragging(false);
  
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault(); 
    const zoomSensitivity = 0.001;
    const newZoom = Math.max(0.1, Math.min(5, camera.zoom - e.deltaY * zoomSensitivity));
    setCamera(prev => ({ ...prev, zoom: newZoom }));
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;
    const cx = width / 2;
    const cy = height / 2;

    ctx.clearRect(0, 0, width, height);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const fov = 800;

    // --- PROJECTION HELPER ---
    const project = (x: number, y: number, z: number) => {
      const focusZ = -200;
      const dx = x;
      const dy = y;
      const dz = z - focusZ; 

      const cosY = Math.cos(camera.yaw);
      const sinY = Math.sin(camera.yaw);
      const x1 = dx * cosY - dy * sinY;
      const y1 = dx * sinY + dy * cosY;
      const z1 = dz;

      const cx_ = x1;
      const cy_ = z1; 
      const cz_ = y1; 

      const cosP = Math.cos(camera.pitch);
      const sinP = Math.sin(camera.pitch);
      
      const x2 = cx_;
      const y2 = cy_ * cosP - cz_ * sinP;
      const z2 = cy_ * sinP + cz_ * cosP;

      const cameraDistance = 600 / camera.zoom;
      const depth = cameraDistance - z2;
      
      // Simple clipping
      if (depth < 1) return null; 

      const scale = fov / depth;
      const sx = cx + x2 * scale + camera.panX;
      const sy = cy - y2 * scale + camera.panY; 

      return { x: sx, y: sy, scale, depth };
    };

    const drawLine3D = (p1: any, p2: any, color: string, width: number = 2, shadow: boolean = false) => {
      if (!p1 || !p2) return;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = width * ((p1.scale + p2.scale)/2);
      if (shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetX = 5;
        ctx.shadowOffsetY = 5;
      }
      ctx.stroke();
      if (shadow) {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }
    };

    const drawPoint3D = (p: any, color: string, radius: number = 3) => {
      if (!p) return;
      
      // Volumetric sphere look
      const r = radius * p.scale;
      if (r < 0.5) return;

      const grad = ctx.createRadialGradient(
        p.x - r*0.3, p.y - r*0.3, r * 0.1,
        p.x, p.y, r
      );
      grad.addColorStop(0, '#fff');
      grad.addColorStop(0.3, color);
      grad.addColorStop(1, '#000');
      
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = showLighting ? grad : color;
      ctx.fill();
    };

    // --- SCENE RENDERING ---
    const bedZ = -400; 
    const gridSize = 300;
    const gridStep = 50;
    
    // 1. Grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for(let i = -gridSize; i <= gridSize; i+=gridStep) {
      const p1 = project(i, -gridSize, bedZ);
      const p2 = project(i, gridSize, bedZ);
      if(p1 && p2) { ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); }
      
      const p3 = project(-gridSize, i, bedZ);
      const p4 = project(gridSize, i, bedZ);
      if(p3 && p4) { ctx.moveTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); }
    }
    ctx.stroke();
    
    // 2. Workspace Cylinder (Floor)
    const rLimit = 184 / 2; 
    
    ctx.beginPath();
    for (let a = 0; a <= Math.PI * 2.1; a += 0.1) {
      const p = project(Math.cos(a) * rLimit, Math.sin(a) * rLimit, bedZ);
      if (p) ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = 'rgba(255, 200, 0, 0.2)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 200, 0, 0.05)';
    ctx.fill();

    // 3. Robot Arm Shadows (Projected to Floor)
    const motorPoints = MOTOR_OFFSET_ANGLES.map(angleDeg => {
      const angle = (angleDeg * Math.PI) / 180;
      return {
        x: Math.cos(angle) * specs.baseRadius,
        y: Math.sin(angle) * specs.baseRadius,
        z: 0
      };
    });
    
    const wristZ = position.z + specs.nozzleLength;
    const thetas = [angles.theta1, angles.theta2, angles.theta3];

    if (showLighting) {
        motorPoints.forEach((mp, i) => {
            const motorAngleRad = (MOTOR_OFFSET_ANGLES[i] * Math.PI) / 180;
            const theta = (thetas[i] * Math.PI) / 180;
            const outwardX = Math.cos(motorAngleRad);
            const outwardY = Math.sin(motorAngleRad);
            
            const elbowX = mp.x + (specs.bicepLength * Math.cos(theta)) * outwardX;
            const elbowY = mp.y + (specs.bicepLength * Math.cos(theta)) * outwardY;
            
            const effOffsetX = specs.effectorRadius * Math.cos(motorAngleRad);
            const effOffsetY = specs.effectorRadius * Math.sin(motorAngleRad);
            const connX = position.x + effOffsetX;
            const connY = position.y + effOffsetY;
            
            const pMotorS = project(mp.x, mp.y, bedZ);
            const pElbowS = project(elbowX, elbowY, bedZ);
            const pConnS = project(connX, connY, bedZ);
            
            ctx.beginPath();
            if(pMotorS) ctx.moveTo(pMotorS.x, pMotorS.y);
            if(pElbowS) ctx.lineTo(pElbowS.x, pElbowS.y);
            if(pConnS) ctx.lineTo(pConnS.x, pConnS.y);
            ctx.strokeStyle = 'rgba(0,0,0,0.3)';
            ctx.lineWidth = 6 * camera.zoom;
            ctx.lineCap = 'round';
            ctx.filter = 'blur(4px)';
            ctx.stroke();
            ctx.filter = 'none';
        });
    }

    // --- PATH RENDERING ---
    if (simPath && simPath.original.length > 0) {
      // 4. Ghost Path (Travel/Shadow)
      // Drawn first to be behind everything
      if (showGhost) {
        ctx.beginPath();
        ctx.strokeStyle = `rgba(255, 255, 255, 0.05)`;
        ctx.lineWidth = 1 * camera.zoom;
        let first = true;
        for(let i = 0; i < simPath.original.length; i++) {
          const pt = simPath.original[i];
          const p = project(pt.x, pt.y, pt.z);
          if (p) {
            if (first) { ctx.moveTo(p.x, p.y); first = false; } 
            else { ctx.lineTo(p.x, p.y); }
          } else { first = true; }
        }
        ctx.stroke();
      }

      if (playbackIndex > 0) {
        
        // --- 3D MATERIAL RENDERING SYSTEM ---
        
        // A. Project & Group points by Layer (Z-height) for correct occlusion
        // We only process points up to playbackIndex
        const pointsToRender = simPath.original.slice(0, playbackIndex + 1);
        
        interface LayerBatch {
            z: number;
            segments: {p1: any, p2: any, isTravel: boolean}[];
        }
        
        const layers: LayerBatch[] = [];
        let currentLayer: LayerBatch | null = null;
        
        // Threshold for new layer detection
        const LAYER_Z_THRESHOLD = 0.05;

        // Optimization: Project points only once
        const projectedPoints = pointsToRender.map(pt => ({
            ...project(pt.x, pt.y, pt.z),
            isTravel: pt.isTravel,
            worldZ: pt.z
        }));

        for(let i = 1; i < projectedPoints.length; i++) {
            const p1 = projectedPoints[i-1];
            const p2 = projectedPoints[i];
            
            // Skip invalid projections
            if (!p1.x || !p2.x) continue;

            // Determine if we are starting a new layer
            // Logic: if Z changes significantly or no layer exists
            if (!currentLayer || Math.abs(p2.worldZ - currentLayer.z) > LAYER_Z_THRESHOLD) {
                currentLayer = { z: p2.worldZ, segments: [] };
                layers.push(currentLayer);
            }
            
            currentLayer.segments.push({ p1, p2, isTravel: !!p2.isTravel });
        }

        // B. CAST SHADOW ON FLOOR (All layers combined)
        // We draw this before the layers so it's underneath
        if (showLighting) {
             ctx.beginPath();
             ctx.strokeStyle = 'rgba(0,0,0,0.4)';
             ctx.lineWidth = 4 * camera.zoom;
             ctx.filter = 'blur(4px)';
             
             // Project path to floor
             let first = true;
             for(let i = 0; i < pointsToRender.length; i++) {
                 const pt = pointsToRender[i];
                 if(pt.isTravel) { first = true; continue; } // Skip travel moves for shadow
                 
                 const pFloor = project(pt.x, pt.y, bedZ);
                 if (pFloor) {
                    if (first) { ctx.moveTo(pFloor.x, pFloor.y); first = false; }
                    else { ctx.lineTo(pFloor.x, pFloor.y); }
                 }
             }
             ctx.stroke();
             ctx.filter = 'none';
        }

        // C. RENDER LAYERS (Bottom-Up for correct occlusion)
        // Sort layers by Z (Lowest first)
        // If camera is looking from below, we might want to reverse, but typically top-down is fine
        layers.sort((a, b) => a.z - b.z);

        const outlineColor = '#880022'; // Dark Burgundy
        const bodyColor = '#ff6b8b';    // Salmon Pink (Like the image)
        const highlightColor = 'rgba(255, 230, 235, 0.7)';
        const travelColor = 'rgba(14, 165, 233, 0.3)';

        // Widths scaled by zoom
        const baseWidth = 4.0 * camera.zoom; // Fat lines for solid look
        const outlineWidth = baseWidth + 1.5; 
        const highlightWidth = baseWidth * 0.4;

        layers.forEach(layer => {
            // 1. Travel Moves (Draw first in layer)
            ctx.beginPath();
            ctx.strokeStyle = travelColor;
            ctx.lineWidth = 1 * camera.zoom;
            layer.segments.forEach(seg => {
                if(seg.isTravel) {
                    ctx.moveTo(seg.p1.x, seg.p1.y);
                    ctx.lineTo(seg.p2.x, seg.p2.y);
                }
            });
            ctx.stroke();

            // 2. Extrusion - Outline (Depth)
            // By drawing outline for the whole layer, we merge adjacent lines in the layer
            ctx.beginPath();
            ctx.strokeStyle = outlineColor;
            ctx.lineWidth = outlineWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            layer.segments.forEach(seg => {
                if(!seg.isTravel) {
                    ctx.moveTo(seg.p1.x, seg.p1.y);
                    ctx.lineTo(seg.p2.x, seg.p2.y);
                }
            });
            ctx.stroke();

            // 3. Extrusion - Body (Color)
            ctx.beginPath();
            ctx.strokeStyle = bodyColor;
            ctx.lineWidth = baseWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            layer.segments.forEach(seg => {
                if(!seg.isTravel) {
                    ctx.moveTo(seg.p1.x, seg.p1.y);
                    ctx.lineTo(seg.p2.x, seg.p2.y);
                }
            });
            ctx.stroke();

            // 4. Extrusion - Highlight (Top Edge Specular)
            if (showLighting) {
                ctx.beginPath();
                ctx.strokeStyle = highlightColor;
                ctx.lineWidth = highlightWidth;
                ctx.lineCap = 'round';
                // Offset calculation for "Top-Left" lighting
                const offX = -1.5 * camera.zoom;
                const offY = -1.5 * camera.zoom;
                
                layer.segments.forEach(seg => {
                    if(!seg.isTravel) {
                        ctx.moveTo(seg.p1.x + offX, seg.p1.y + offY);
                        ctx.lineTo(seg.p2.x + offX, seg.p2.y + offY);
                    }
                });
                ctx.stroke();
            }
        });

      }
    }


    // 6. Base Plate (Top) - Volumetric
    
    // Draw Base Shadow
    ctx.beginPath();
    motorPoints.forEach((mp, i) => {
      const p = project(mp.x, mp.y, bedZ);
      if(p) i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.filter = 'blur(10px)';
    ctx.fill();
    ctx.filter = 'none';

    // Draw Base Plate
    ctx.beginPath();
    motorPoints.forEach((mp, i) => {
      const p = project(mp.x, mp.y, mp.z);
      if(p) i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
    });
    const p0 = project(motorPoints[0].x, motorPoints[0].y, motorPoints[0].z);
    if(p0) ctx.lineTo(p0.x, p0.y);
    
    // Gradient for metallic look
    const pBaseCenter = project(0,0,0);
    if (pBaseCenter) {
        const grad = ctx.createRadialGradient(
            pBaseCenter.x, pBaseCenter.y, 0,
            pBaseCenter.x, pBaseCenter.y, 100 * pBaseCenter.scale
        );
        grad.addColorStop(0, '#334155');
        grad.addColorStop(1, '#0f172a');
        ctx.fillStyle = grad;
    } else {
        ctx.fillStyle = '#1e293b';
    }
    ctx.fill();
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 7. Arms & Effector
    
    motorPoints.forEach((mp, i) => {
      const motorAngleRad = (MOTOR_OFFSET_ANGLES[i] * Math.PI) / 180;
      const theta = (thetas[i] * Math.PI) / 180;

      // Elbow Calculation
      const outwardX = Math.cos(motorAngleRad);
      const outwardY = Math.sin(motorAngleRad);
      
      const elbowX = mp.x + (specs.bicepLength * Math.cos(theta)) * outwardX;
      const elbowY = mp.y + (specs.bicepLength * Math.cos(theta)) * outwardY;
      const elbowZ = mp.z + (specs.bicepLength * Math.sin(theta));

      // Wrist Connection Point (on effector)
      const effOffsetX = specs.effectorRadius * Math.cos(motorAngleRad);
      const effOffsetY = specs.effectorRadius * Math.sin(motorAngleRad);
      const connX = position.x + effOffsetX;
      const connY = position.y + effOffsetY;
      const connZ = wristZ;

      const pMotor = project(mp.x, mp.y, mp.z);
      const pElbow = project(elbowX, elbowY, elbowZ);
      const pConn = project(connX, connY, connZ);

      // Towers (Rails)
      const pTowerTop = project(mp.x, mp.y, 100);
      const pTowerBot = project(mp.x, mp.y, bedZ);
      
      // Draw Tower rail
      if(pTowerTop && pTowerBot) {
          ctx.beginPath();
          ctx.moveTo(pTowerTop.x, pTowerTop.y);
          ctx.lineTo(pTowerBot.x, pTowerBot.y);
          ctx.strokeStyle = 'rgba(255,255,255,0.1)';
          ctx.lineWidth = 4 * camera.zoom;
          ctx.stroke();
      }

      if (angles.isValid) {
        // Bicep
        drawLine3D(pMotor, pElbow, '#0ea5e9', 6, true);
        drawPoint3D(pMotor, '#e2e8f0', 4);
        
        // Forearm (Parallel rods look)
        drawLine3D(pElbow, pConn, '#cbd5e1', 3, true);
        
        drawPoint3D(pElbow, '#38bdf8', 3);
        drawPoint3D(pConn, '#10b981', 3);
      } else {
        drawLine3D(pMotor, pElbow, '#ef4444', 2);
        drawLine3D(pElbow, pConn, '#ef4444', 1);
        drawPoint3D(pMotor, '#ef4444', 3);
      }
    });

    // 8. Effector Plate (Wrist Level)
    const pWristCenter = project(position.x, position.y, wristZ);
    ctx.beginPath();
    const effPoly = MOTOR_OFFSET_ANGLES.map(angleDeg => {
      const angle = (angleDeg * Math.PI) / 180;
      return project(
        position.x + specs.effectorRadius * Math.cos(angle),
        position.y + specs.effectorRadius * Math.sin(angle),
        wristZ
      );
    });
    if (effPoly[0]) {
      ctx.moveTo(effPoly[0].x, effPoly[0].y);
      effPoly.forEach(p => p && ctx.lineTo(p.x, p.y));
      ctx.closePath();
      
      // Effector Gradient
      if (pWristCenter) {
          const gradEff = ctx.createRadialGradient(
             pWristCenter.x, pWristCenter.y, 0,
             pWristCenter.x, pWristCenter.y, 30 * pWristCenter.scale
          );
          gradEff.addColorStop(0, angles.isValid ? '#34d399' : '#f87171');
          gradEff.addColorStop(1, angles.isValid ? '#059669' : '#dc2626');
          ctx.fillStyle = gradEff;
      } else {
          ctx.fillStyle = angles.isValid ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.2)';
      }
      
      ctx.fill();
      ctx.strokeStyle = angles.isValid ? '#10b981' : '#ef4444';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    
    // 9. Nozzle (Yellow Rod) from Wrist to Tip
    const pTip = project(position.x, position.y, position.z);
    drawLine3D(pWristCenter, pTip, '#fbbf24', 5); 
    drawPoint3D(pTip, '#fbbf24', 4); // Tip dot

  }, [specs, position, angles, camera, simPath, playbackIndex, showGhost, showLighting]);

  return (
    <div 
      ref={containerRef}
      className="relative w-full h-full bg-slate-900 rounded-xl overflow-hidden shadow-2xl border border-slate-800 cursor-move group select-none"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} className="w-full h-full block bg-gradient-to-b from-slate-900 to-slate-950" />
      
      {/* HUD */}
      <div className="absolute top-4 right-4 flex flex-col items-end space-y-2 pointer-events-none">
        <div className="bg-slate-950/80 backdrop-blur p-2 rounded border border-slate-700 text-xs font-mono text-slate-400 pointer-events-auto shadow-lg">
          <div className="flex items-center space-x-2 mb-1 border-b border-slate-800 pb-1">
            <span className="text-blue-400 font-bold">ORBIT CAM</span>
            <div className={angles.isValid ? "text-emerald-500" : "text-red-500"}>
              {angles.isValid ? "● OK" : "● INVALID POS"}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] opacity-70">
            <div>LMB: Rotate</div>
            <div>RMB: Pan</div>
          </div>
        </div>
        <div className="flex space-x-2 pointer-events-auto">
          <button 
            onClick={() => setShowLighting(!showLighting)}
            className={`flex items-center space-x-1 p-2 rounded text-xs border shadow-lg transition-colors ${showLighting ? 'bg-amber-600 text-white border-amber-500' : 'bg-slate-800 text-slate-400 border-slate-600'}`}
            title="Toggle Lights & Shadows"
          >
            <Sun size={14} />
          </button>
          <button 
            onClick={() => setShowGhost(!showGhost)}
            className={`flex items-center space-x-1 p-2 rounded text-xs border shadow-lg transition-colors ${showGhost ? 'bg-indigo-600 text-white border-indigo-500' : 'bg-slate-800 text-slate-400 border-slate-600'}`}
            title="Toggle Ghost Path"
          >
            {showGhost ? <Eye size={14} /> : <EyeOff size={14} />}
            <span>Ghost</span>
          </button>
          <button 
            onClick={resetView}
            className="flex items-center space-x-1 bg-slate-800 hover:bg-slate-700 text-white p-2 rounded text-xs border border-slate-600 shadow-lg transition-colors"
          >
            <RotateCcw size={14} />
            <span>Reset Cam</span>
          </button>
        </div>
      </div>
      
      {/* Legend for Sim Path */}
      {simPath && (
        <div className="absolute top-4 left-4 bg-slate-950/80 p-2 rounded border border-slate-700 pointer-events-none shadow-lg">
          <div className="text-[10px] font-bold text-slate-400 mb-1">TRACE LEGEND</div>
          <div className="flex items-center space-x-2">
            <div className="w-3 h-0.5 bg-[#f43f5e] shadow-[0_0_5px_rgba(244,63,94,0.8)]"></div>
            <span className="text-[10px] text-rose-500">Material</span>
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-3 h-0.5 bg-sky-500"></div>
            <span className="text-[10px] text-sky-500">Travel</span>
          </div>
           <div className="flex items-center space-x-2 opacity-50">
            <div className="w-3 h-0.5 bg-white"></div>
            <span className="text-[10px] text-white">Ghost</span>
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-3 h-0.5 bg-yellow-500"></div>
            <span className="text-[10px] text-yellow-500">Nozzle</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default DeltaVisualizer;