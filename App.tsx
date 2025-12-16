import React, { useState, useMemo, useRef, useEffect } from 'react';
import { 
  Calculator, 
  Cpu, 
  Settings, 
  Box, 
  RotateCcw, 
  Terminal, 
  Info,
  ChevronRight,
  Printer,
  XCircle,
  CheckCircle2,
  FileUp,
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Clock,
  Gauge,
  Ruler,
  Move,
  FileText,
  Download,
  Layers,
  Zap,
  Loader2,
  Scale,
  DollarSign,
  Activity,
  MousePointer2
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer 
} from 'recharts';
import { DEFAULT_SPECS, DEFAULT_COST_SETTINGS, INITIAL_POSITION } from './constants';
import { RobotSpecs, Position, SimulationPath, ModelTransform, CostSettings, GCodeParsed } from './types';
import DeltaVisualizer from './components/DeltaVisualizer';
import { 
  calculateInverseKinematics, 
  calculateVolumeMetrics, 
  calculateForwardKinematics, 
  simulateMotorQuantization
} from './utils/kinematics';
import { parseGCodeFile } from './utils/gcodeParser';

// Tabs
enum Tab {
  SIMULATOR = 'SIMULATOR',
  CALCULATOR = 'CALCULATOR',
  PROMPT = 'PROMPT',
  ABOUT = 'ABOUT'
}

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>(Tab.SIMULATOR);
  const [specs, setSpecs] = useState<RobotSpecs>(DEFAULT_SPECS);
  const [costSettings, setCostSettings] = useState<CostSettings>(DEFAULT_COST_SETTINGS);
  const [position, setPosition] = useState<Position>(INITIAL_POSITION);
  const [promptCopied, setPromptCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Simulation State
  const [simPath, setSimPath] = useState<SimulationPath | undefined>(undefined);
  const [simMode, setSimMode] = useState<'NEMA17' | 'SERVO_MG995'>('NEMA17');
  
  // Model Transform & GCode State
  const [gcodeData, setGcodeData] = useState<GCodeParsed | null>(null);
  const [modelTransform, setModelTransform] = useState<ModelTransform>({
    x: 0, y: 0, z: -300, scale: 1, rotation: 0
  });
  
  // Loading State
  const [isParsing, setIsParsing] = useState(false);

  // Animation State
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(10); // Faster default speed for G-code

  // Derived State for Current Animation Frame
  const currentSimPosition = useMemo(() => {
    if (simPath && simPath.simulated.length > 0) {
      return simPath.simulated[playbackIndex] || position;
    }
    return position;
  }, [simPath, playbackIndex, position]);

  const effectivePosition = simPath ? currentSimPosition : position;
  const angles = useMemo(() => calculateInverseKinematics(specs, effectivePosition), [specs, effectivePosition]);
  const metrics = useMemo(() => calculateVolumeMetrics(specs), [specs]);

  const handleSpecChange = (key: keyof RobotSpecs, value: any) => {
    setSpecs(prev => ({ ...prev, [key]: value }));
  };

  const handleCostChange = (key: keyof CostSettings, value: number) => {
    setCostSettings(prev => ({ ...prev, [key]: value }));
  };

  const handlePositionChange = (key: keyof Position, value: number) => {
    setPosition(prev => ({ ...prev, [key]: value }));
  };
  
  const handleTransformChange = (key: keyof ModelTransform, value: number) => {
    setModelTransform(prev => ({ ...prev, [key]: value }));
  };

  const copyPrompt = () => {
    const text = document.getElementById('ai-prompt')?.innerText;
    if (text) {
      navigator.clipboard.writeText(text);
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 2000);
    }
  };

  // --- ANIMATION LOOP ---
  useEffect(() => {
    let intervalId: number;
    if (isPlaying && simPath) {
      intervalId = window.setInterval(() => {
        setPlaybackIndex(prev => {
          const next = prev + (1 * playbackSpeed);
          if (next >= simPath.original.length - 1) {
            setIsPlaying(false);
            return simPath.original.length - 1;
          }
          return next;
        });
      }, 20); // 50fps
    }
    return () => clearInterval(intervalId);
  }, [isPlaying, simPath, playbackSpeed]);

  // --- EFFECT: Re-calculate simulation path when Transform changes ---
  useEffect(() => {
    if (gcodeData) {
      // Re-apply transform to raw G-code points
      const transformedPoints = gcodeData.points.map(p => ({
        x: p.x * modelTransform.scale + modelTransform.x,
        y: p.y * modelTransform.scale + modelTransform.y,
        z: p.z * modelTransform.scale + modelTransform.z, // Map G-code Z to Bed Z
        isTravel: p.isTravel,
        e: p.e
      }));
      runSimulation(transformedPoints);
    }
  }, [gcodeData, modelTransform, simMode]);

  // --- HANDLERS ---

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsParsing(true);
    setGcodeData(null);
    setSimPath(undefined);
    setIsPlaying(false);

    // Use setTimeout to allow UI to render loading state
    setTimeout(() => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string;
        const parsed = parseGCodeFile(content);
        
        // Auto-Center logic:
        // G-code often is 0-200. We want to center it at 0,0.
        const centerX = (parsed.boundingBox.min.x + parsed.boundingBox.max.x) / 2;
        const centerY = (parsed.boundingBox.min.y + parsed.boundingBox.max.y) / 2;
        
        // Set initial transform to center the model and place it on bed (-300 typically)
        setModelTransform(prev => ({
          ...prev,
          x: -centerX,
          y: -centerY,
          z: -300 // Default bed level for typical delta config
        }));

        setGcodeData(parsed);
        setIsParsing(false);
      };
      reader.readAsText(file);
    }, 100);
  };

  const runSimulation = (targetPoints: Position[]) => {
    const simulatedPoints: Position[] = [];

    targetPoints.forEach(pt => {
      const idealAngles = calculateInverseKinematics(specs, pt);
      if(!idealAngles.isValid) {
        simulatedPoints.push(pt); 
        return;
      }
      const noisyAngles = simulateMotorQuantization(idealAngles, simMode);
      const actualPos = calculateForwardKinematics(specs, noisyAngles as [number,number,number]);
      if(actualPos) {
        simulatedPoints.push({ ...actualPos, isTravel: pt.isTravel });
      } else {
        simulatedPoints.push(pt);
      }
    });

    setSimPath({
      original: targetPoints,
      simulated: simulatedPoints
    });
    // Do not reset playback index on simple transform changes to allow dragging while playing
    if (!simPath) setPlaybackIndex(0);
  };

  const changeSimMode = (mode: 'NEMA17' | 'SERVO_MG995') => {
    setSimMode(mode);
    // Simulation will update via Effect
  };

  // --- STATS CALCULATIONS ---
  const calculateCosts = () => {
    if (!gcodeData) return { power: 0, filament: 0, total: 0 };
    
    // Power: kW * Hours * Cost
    const hours = gcodeData.totalTime / 3600;
    const kW = costSettings.powerRating / 1000;
    const powerCost = hours * kW * costSettings.electricityCost;

    // Filament: Weight (g) * Cost ($/kg) / 1000
    // Weight = Volume * Density
    // Volume = Length * Area = Length * pi * (1.75/2)^2
    const radiusCm = 0.175 / 2; // 1.75mm -> 0.175cm
    const lengthCm = gcodeData.totalFilament / 10;
    const volumeCm3 = lengthCm * Math.PI * (radiusCm * radiusCm);
    const weightG = volumeCm3 * costSettings.filamentDensity;
    const matCost = (weightG / 1000) * costSettings.filamentCost;

    return {
      power: powerCost,
      filament: matCost,
      weight: weightG,
      total: powerCost + matCost
    };
  };

  const costs = calculateCosts();
  const motorMath = useMemo(() => {
    // ... (Existing MotorMath logic)
    const nemaBaseStep = 1.8;
    const microsteps = specs.microstepping;
    const nemaResolutionDeg = nemaBaseStep / microsteps;
    const nemaArcRes = specs.bicepLength * (nemaResolutionDeg * (Math.PI / 180));
    const pwmRangeUs = 2000;
    const servoDeadbandUs = 5; 
    const servoSteps = pwmRangeUs / servoDeadbandUs; 
    const servoResolutionDeg = 180 / servoSteps; 
    const servoArcRes = specs.bicepLength * (servoResolutionDeg * (Math.PI / 180));
    return {
      nema: { stepAngle: nemaBaseStep, microsteps, resDeg: nemaResolutionDeg, resLin: nemaArcRes },
      servo: { range: 180, deadband: servoDeadbandUs, steps: servoSteps, resDeg: servoResolutionDeg, resLin: servoArcRes }
    };
  }, [specs]);

  const formatDuration = (secs: number) => {
    if (secs < 60) return `${secs.toFixed(0)}s`;
    if (secs < 3600) return `${Math.floor(secs/60)}m ${Math.floor(secs%60)}s`;
    return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`;
  };

  // Helper for current filament
  const currentFilament = useMemo(() => {
    if (!gcodeData || !simPath || playbackIndex >= simPath.original.length) return 0;
    return simPath.original[playbackIndex].e || 0;
  }, [gcodeData, simPath, playbackIndex]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col font-sans">
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-blue-600 p-2 rounded-lg">
              <Cpu size={24} className="text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white tracking-tight">DeltaSim Pro</h1>
              <p className="text-xs text-slate-400 font-mono">SCARA // PARALLEL // KINEMATICS</p>
            </div>
          </div>
          <nav className="flex items-center space-x-1 bg-slate-800/50 p-1 rounded-lg border border-slate-700/50">
            {[
              { id: Tab.SIMULATOR, icon: Box, label: 'G-Code Visualizer' },
              { id: Tab.CALCULATOR, icon: Calculator, label: 'Motor Math' },
              { id: Tab.PROMPT, icon: Terminal, label: 'AI Prompt' },
              { id: Tab.ABOUT, icon: Info, label: 'Specs' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center space-x-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  activeTab === tab.id 
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/20' 
                    : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                }`}
              >
                <tab.icon size={16} />
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full p-4 sm:p-6 lg:p-8">
        
        {activeTab === Tab.SIMULATOR && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-140px)]">
            <div className="lg:col-span-2 flex flex-col space-y-4">
              {/* Visualizer gets effectivePosition (animated) */}
              <div className="relative h-full flex-1 min-h-[500px]">
                <DeltaVisualizer 
                   specs={specs} 
                   position={effectivePosition} 
                   angles={angles} 
                   simPath={simPath} 
                   playbackIndex={playbackIndex}
                />
                {isParsing && (
                  <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center z-50">
                    <Loader2 size={48} className="text-blue-500 animate-spin mb-4" />
                    <h2 className="text-xl font-bold text-white">Parsing G-Code...</h2>
                    <p className="text-slate-400">Extracting coordinates & Extrusion data</p>
                  </div>
                )}
                
                {/* Live Playback Stats Overlay */}
                {simPath && (
                   <div className="absolute bottom-4 left-4 bg-slate-950/80 backdrop-blur p-3 rounded-lg border border-slate-700 text-xs font-mono space-y-1 z-10">
                      <div className="flex justify-between gap-4">
                        <span className="text-slate-400">Step:</span>
                        <span className="text-blue-400 font-bold">{playbackIndex} / {simPath.original.length}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-slate-400">Filament:</span>
                        <span className="text-emerald-400 font-bold">{currentFilament.toFixed(1)}mm / {gcodeData?.totalFilament.toFixed(1)}mm</span>
                      </div>
                      <div className="flex justify-between gap-4 border-t border-slate-700 pt-1 mt-1">
                        <span className="text-slate-400">Position:</span>
                        <span className="text-white font-bold">
                          X{effectivePosition.x.toFixed(1)} Y{effectivePosition.y.toFixed(1)} Z{effectivePosition.z.toFixed(1)}
                        </span>
                      </div>
                   </div>
                )}
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: 'Theta 1', value: angles.isValid ? angles.theta1.toFixed(1) + '°' : '--' },
                  { label: 'Theta 2', value: angles.isValid ? angles.theta2.toFixed(1) + '°' : '--' },
                  { label: 'Theta 3', value: angles.isValid ? angles.theta3.toFixed(1) + '°' : '--' },
                ].map((stat, i) => (
                  <div key={i} className="bg-slate-900 border border-slate-800 p-3 rounded-lg flex flex-col items-center">
                    <span className="text-xs text-slate-500 uppercase font-mono">{stat.label}</span>
                    <span className={`text-xl font-mono font-bold ${angles.isValid ? 'text-blue-400' : 'text-red-400'}`}>
                      {stat.value}
                    </span>
                  </div>
                ))}
              </div>

            </div>

            <div className="space-y-4 overflow-y-auto pr-2 custom-scrollbar pb-20">
              
              {/* --- CONTROL PANEL --- */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                   <div className="flex items-center space-x-2">
                     <Layers size={18} className="text-emerald-500" />
                     <h3 className="font-semibold text-white">G-Code Control</h3>
                   </div>
                </div>

                <div className="space-y-4">
                  {/* File Upload */}
                  {!simPath && (
                    <div className="p-4 border-2 border-dashed border-slate-700 rounded-lg text-center hover:border-slate-500 transition-colors">
                      <input 
                        type="file" 
                        accept=".gcode,.txt" 
                        ref={fileInputRef} 
                        onChange={handleFileUpload} 
                        className="hidden" 
                      />
                      <button 
                        onClick={() => fileInputRef.current?.click()}
                        className="flex flex-col items-center w-full"
                      >
                        <FileUp className="text-slate-400 mb-2" />
                        <span className="text-sm font-medium text-slate-300">Upload G-Code File</span>
                        <span className="text-xs text-slate-500 mt-1">Accepts standard .gcode</span>
                      </button>
                    </div>
                  )}

                  {/* Playback Controls (Visible when file loaded) */}
                  {simPath && (
                    <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-3">
                      {/* Scrubber */}
                      <input 
                        type="range"
                        min={0}
                        max={simPath.original.length - 1}
                        value={playbackIndex}
                        onChange={(e) => {
                          setPlaybackIndex(parseInt(e.target.value));
                          setIsPlaying(false);
                        }}
                        className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                      />

                      {/* Control Buttons */}
                      <div className="flex items-center justify-center space-x-4">
                         <button onClick={() => setPlaybackIndex(Math.max(0, playbackIndex - 100))} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded">
                           <SkipBack size={16} />
                         </button>
                         <button 
                           onClick={() => setIsPlaying(!isPlaying)}
                           className={`p-3 rounded-full ${isPlaying ? 'bg-amber-500 text-black' : 'bg-blue-600 text-white'} hover:opacity-90 transition-colors shadow-lg`}
                         >
                           {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-0.5" />}
                         </button>
                         <button onClick={() => setPlaybackIndex(Math.min(simPath.original.length - 1, playbackIndex + 100))} className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded">
                           <SkipForward size={16} />
                         </button>
                      </div>

                      <div className="flex justify-between items-center pt-2 border-t border-slate-800/50">
                        <button 
                          onClick={() => { setSimPath(undefined); setIsPlaying(false); setGcodeData(null); }}
                          className="text-[10px] text-red-400 hover:underline"
                        >
                          Clear File
                        </button>
                        <div className="flex items-center space-x-2">
                            <span className="text-[10px] text-slate-500">Speed</span>
                            <input 
                                type="number" 
                                value={playbackSpeed}
                                onChange={(e) => setPlaybackSpeed(parseInt(e.target.value))}
                                className="w-12 bg-slate-900 border border-slate-700 text-[10px] rounded px-1"
                            />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

               {/* --- MANUAL POSITION CONTROLS --- */}
               <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm opacity-90">
                  <div className="flex items-center space-x-2 mb-4">
                    <MousePointer2 size={18} className="text-amber-500" />
                    <h3 className="font-semibold text-white">Manual Jog Control</h3>
                    {simPath && <span className="text-[10px] bg-slate-800 px-1 rounded text-slate-400 ml-auto">LOCKED BY GCODE</span>}
                  </div>
                  <div className="space-y-4">
                    {/* X Slider */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                         <span className="text-slate-400">X Position</span>
                         <span className="text-amber-400 font-mono">{effectivePosition.x.toFixed(1)}mm</span>
                      </div>
                      <input
                         type="range" min={-150} max={150} step={1}
                         value={effectivePosition.x}
                         onChange={(e) => !simPath && handlePositionChange('x', parseFloat(e.target.value))}
                         disabled={!!simPath}
                         className={`w-full h-1.5 bg-slate-800 rounded-lg appearance-none ${simPath ? 'cursor-not-allowed opacity-50' : 'cursor-pointer accent-amber-500'}`}
                      />
                    </div>
                    {/* Y Slider */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                         <span className="text-slate-400">Y Position</span>
                         <span className="text-amber-400 font-mono">{effectivePosition.y.toFixed(1)}mm</span>
                      </div>
                      <input
                         type="range" min={-150} max={150} step={1}
                         value={effectivePosition.y}
                         onChange={(e) => !simPath && handlePositionChange('y', parseFloat(e.target.value))}
                         disabled={!!simPath}
                         className={`w-full h-1.5 bg-slate-800 rounded-lg appearance-none ${simPath ? 'cursor-not-allowed opacity-50' : 'cursor-pointer accent-amber-500'}`}
                      />
                    </div>
                    {/* Z Slider */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                         <span className="text-slate-400">Z Position</span>
                         <span className="text-amber-400 font-mono">{effectivePosition.z.toFixed(1)}mm</span>
                      </div>
                      <input
                         type="range" min={-450} max={-50} step={1}
                         value={effectivePosition.z}
                         onChange={(e) => !simPath && handlePositionChange('z', parseFloat(e.target.value))}
                         disabled={!!simPath}
                         className={`w-full h-1.5 bg-slate-800 rounded-lg appearance-none ${simPath ? 'cursor-not-allowed opacity-50' : 'cursor-pointer accent-amber-500'}`}
                      />
                    </div>
                  </div>
               </div>

               {/* --- STATS & COST ESTIMATOR --- */}
               {gcodeData && (
                 <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm opacity-90 animate-in fade-in slide-in-from-right-4">
                    <div className="flex items-center space-x-2 mb-4">
                        <DollarSign size={18} className="text-emerald-500" />
                        <h3 className="font-semibold text-white">Production Estimate</h3>
                    </div>
                    
                    {/* Cost Inputs */}
                    <div className="grid grid-cols-2 gap-3 mb-4">
                        <div>
                            <label className="text-[10px] text-slate-400 block mb-1">PSU Wattage (W)</label>
                            <input type="number" value={costSettings.powerRating} onChange={(e)=>handleCostChange('powerRating', parseFloat(e.target.value))} className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white" />
                        </div>
                        <div>
                            <label className="text-[10px] text-slate-400 block mb-1">Energy ($/kWh)</label>
                            <input type="number" step="0.01" value={costSettings.electricityCost} onChange={(e)=>handleCostChange('electricityCost', parseFloat(e.target.value))} className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white" />
                        </div>
                         <div>
                            <label className="text-[10px] text-slate-400 block mb-1">Filament ($/kg)</label>
                            <input type="number" step="1" value={costSettings.filamentCost} onChange={(e)=>handleCostChange('filamentCost', parseFloat(e.target.value))} className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-white" />
                        </div>
                    </div>

                    <div className="bg-slate-950 rounded-lg p-3 space-y-2 border border-slate-800">
                        <div className="flex justify-between items-center text-xs">
                             <span className="text-slate-400 flex items-center gap-1"><Clock size={12}/> Time</span>
                             <span className="font-mono text-white">{formatDuration(gcodeData.totalTime)}</span>
                        </div>
                        <div className="flex justify-between items-center text-xs">
                             <span className="text-slate-400 flex items-center gap-1"><Scale size={12}/> Material</span>
                             <span className="font-mono text-white">{costs.weight.toFixed(1)}g ({(gcodeData.totalFilament/1000).toFixed(1)}m)</span>
                        </div>
                         <div className="flex justify-between items-center text-xs pt-2 border-t border-slate-800">
                             <span className="text-slate-400">Electricity Cost</span>
                             <span className="font-mono text-emerald-400">${costs.power.toFixed(4)}</span>
                        </div>
                        <div className="flex justify-between items-center text-xs">
                             <span className="text-slate-400">Material Cost</span>
                             <span className="font-mono text-emerald-400">${costs.filament.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between items-center text-sm font-bold pt-2 border-t border-slate-800 mt-2">
                             <span className="text-slate-300">TOTAL EST.</span>
                             <span className="font-mono text-emerald-400">${costs.total.toFixed(2)}</span>
                        </div>
                    </div>
                 </div>
               )}

               {/* --- ROBOT GEOMETRY CONFIGURATION --- */}
               <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm opacity-90">
                  <div className="flex items-center space-x-2 mb-4">
                    <Ruler size={18} className="text-purple-500" />
                    <h3 className="font-semibold text-white">Machine Geometry</h3>
                  </div>
                  <div className="space-y-4">
                    
                    {/* Updated Labels to match user diagram: f, rf, re, e */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                         <span className="text-slate-400">Base radius (f)</span>
                         <span className="text-purple-400 font-mono">{specs.baseRadius}mm</span>
                      </div>
                      <input
                         type="range" min={30} max={200} step={1}
                         value={specs.baseRadius}
                         onChange={(e) => handleSpecChange('baseRadius', parseFloat(e.target.value))}
                         className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-purple-500"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between text-xs mb-1">
                         <span className="text-slate-400">Bicep length (rf)</span>
                         <span className="text-purple-400 font-mono">{specs.bicepLength}mm</span>
                      </div>
                      <input
                         type="range" min={50} max={300} step={1}
                         value={specs.bicepLength}
                         onChange={(e) => handleSpecChange('bicepLength', parseFloat(e.target.value))}
                         className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-purple-500"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between text-xs mb-1">
                         <span className="text-slate-400">Forearm length (re)</span>
                         <span className="text-purple-400 font-mono">{specs.forearmLength}mm</span>
                      </div>
                      <input
                         type="range" min={100} max={500} step={1}
                         value={specs.forearmLength}
                         onChange={(e) => handleSpecChange('forearmLength', parseFloat(e.target.value))}
                         className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-purple-500"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between text-xs mb-1">
                         <span className="text-slate-400">End Effector radius (e)</span>
                         <span className="text-purple-400 font-mono">{specs.effectorRadius}mm</span>
                      </div>
                      <input
                         type="range" min={10} max={100} step={1}
                         value={specs.effectorRadius}
                         onChange={(e) => handleSpecChange('effectorRadius', parseFloat(e.target.value))}
                         className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-purple-500"
                      />
                    </div>

                    <div>
                      <label className="text-xs text-slate-500 uppercase font-bold">Orientation</label>
                      <div className="flex space-x-2 mt-1">
                        {['standard', 'upside-down'].map(o => (
                          <button
                            key={o}
                            onClick={() => handleSpecChange('orientation', o)}
                            className={`flex-1 py-1.5 text-xs rounded border ${
                              specs.orientation === o
                                ? 'bg-blue-600/20 border-blue-500 text-blue-400'
                                : 'bg-transparent border-slate-700 text-slate-500 hover:border-slate-600'
                            }`}
                          >
                            {o === 'standard' ? 'Standard' : 'Servo/Inv'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* --- TRANSFORM CONTROLS --- */}
               {gcodeData && (
                 <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm opacity-90 mt-4">
                   <div className="flex items-center space-x-2 mb-4">
                        <Move size={18} className="text-indigo-500" />
                        <h3 className="font-semibold text-white">System Adjustment</h3>
                   </div>
                   <div className="space-y-4">
                      {/* Scale */}
                      <div>
                        <div className="flex justify-between text-xs mb-1">
                           <span className="text-slate-400 uppercase">Scale</span>
                           <span className="text-indigo-400 font-mono">{modelTransform.scale.toFixed(2)}x</span>
                        </div>
                        <input
                           type="range" min={0.1} max={2.0} step={0.05}
                           value={modelTransform.scale}
                           onChange={(e) => handleTransformChange('scale', parseFloat(e.target.value))}
                           className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                        />
                      </div>
                      
                      {/* Position Z */}
                       <div>
                        <div className="flex justify-between text-xs mb-1">
                           <span className="text-slate-400 uppercase">Bed Offset (Z)</span>
                           <span className="text-indigo-400 font-mono">{modelTransform.z.toFixed(0)} mm</span>
                        </div>
                        <input
                           type="range" min={-400} max={-100} step={1}
                           value={modelTransform.z}
                           onChange={(e) => handleTransformChange('z', parseFloat(e.target.value))}
                           className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                        />
                      </div>
                      
                      {/* Position X/Y */}
                       <div className="grid grid-cols-2 gap-4">
                        <div>
                          <div className="flex justify-between text-xs mb-1">
                             <span className="text-slate-400 uppercase">X Offset</span>
                          </div>
                          <input
                             type="range" min={-100} max={100} step={1}
                             value={modelTransform.x}
                             onChange={(e) => handleTransformChange('x', parseFloat(e.target.value))}
                             className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                          />
                        </div>
                         <div>
                          <div className="flex justify-between text-xs mb-1">
                             <span className="text-slate-400 uppercase">Y Offset</span>
                          </div>
                          <input
                             type="range" min={-100} max={100} step={1}
                             value={modelTransform.y}
                             onChange={(e) => handleTransformChange('y', parseFloat(e.target.value))}
                             className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                          />
                        </div>
                      </div>
                   </div>
                 </div>
               )}

            </div>
          </div>
        )}

        {/* ... Calculator, Prompt, About Tabs remain the same ... */}
        {activeTab === Tab.CALCULATOR && (
           <div className="grid grid-cols-1 md:grid-cols-2 gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-10">
            {/* ... Calculator Content ... */}
             <div className="space-y-6">
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
                <h2 className="text-xl font-bold text-white mb-6 flex items-center">
                  <Calculator className="mr-3 text-purple-500" />
                  Motor Math: NEMA 17 vs Servo
                </h2>
                <div className="bg-slate-950/50 rounded-lg p-5 border border-emerald-900/50 mb-6 relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-2 opacity-10">
                    <CheckCircle2 size={80} className="text-emerald-500" />
                  </div>
                  <div className="flex items-center space-x-2 mb-4">
                     <span className="px-2 py-0.5 bg-emerald-900/40 text-emerald-400 text-xs font-bold rounded uppercase">Recommended</span>
                     <h3 className="font-bold text-lg text-white">17HS4401 NEMA 17 Stepper</h3>
                  </div>
                  <div className="space-y-3 text-sm font-mono text-slate-300">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Step Angle (α):</span>
                      <span>{motorMath.nema.stepAngle}°</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Microstepping (M):</span>
                      <span>1/{motorMath.nema.microsteps}</span>
                    </div>
                    <div className="flex justify-between border-t border-slate-800 pt-2">
                      <span className="text-emerald-400">Angular Res (α/M):</span>
                      <span className="font-bold text-white">{motorMath.nema.resDeg.toFixed(4)}°</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ... Prompt Tab ... */}
        {activeTab === Tab.PROMPT && (
          <div className="max-w-4xl mx-auto animate-in fade-in zoom-in-95 duration-300">
             <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 relative overflow-hidden">
               <div className="absolute top-4 right-4 text-slate-700">
                  <Terminal size={120} strokeWidth={0.5} />
               </div>
               <h2 className="text-2xl font-bold text-white mb-6">AI Engineering Prompt</h2>
               <p className="text-slate-400 mb-6 max-w-2xl">
                 Copy this prompt to generate technical diagrams or documentation for your specific machine geometry in tools like Midjourney or ChatGPT.
               </p>
               
               <div className="bg-slate-950 p-6 rounded-lg border border-slate-800 font-mono text-sm text-slate-300 whitespace-pre-wrap relative group" id="ai-prompt">
                 {`Create a technical engineering diagram of a Rotary Delta Robot (Parallel SCARA) with the following specifications:

DIMENSIONS:
- Base Radius (f): ${specs.baseRadius}mm
- Bicep Length (rf): ${specs.bicepLength}mm
- Forearm Length (re): ${specs.forearmLength}mm
- End Effector Radius (e): ${specs.effectorRadius}mm

CONFIGURATION:
- Motors: 3x ${specs.motorType} at 120-degree spacing
- Orientation: ${specs.orientation.toUpperCase()}
- Application: 3D Printing / Pick & Place

STYLE:
- Clean vector line art, white background
- Isometric view showing linkage kinematics
- Callouts for 'f', 'rf', 're', 'e' dimensions
- High contrast, blue and dark grey technical accents`}
                 
                 <button 
                   onClick={copyPrompt}
                   className="absolute top-4 right-4 bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded text-xs transition-colors opacity-0 group-hover:opacity-100"
                 >
                   {promptCopied ? 'Copied!' : 'Copy Prompt'}
                 </button>
               </div>
             </div>
          </div>
        )}

        {/* ... About Tab ... */}
        {activeTab === Tab.ABOUT && (
          <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in duration-500">
             <div className="bg-slate-900 border border-slate-800 rounded-xl p-8">
               <h2 className="text-2xl font-bold text-white mb-4">About Rotary Delta Printers</h2>
               <div className="prose prose-invert prose-slate max-w-none">
                 <p className="text-slate-400">
                   Unlike traditional Linear Delta printers that move carriages up and down vertical rails, a <strong>Rotary Delta</strong> (often called a Parallel SCARA) uses rotating arms attached to fixed motors. This simulator handles the complex non-linear kinematics required to translate Cartesian G-code (X,Y,Z) into the required motor angles (Theta 1, 2, 3).
                 </p>
               </div>
             </div>
          </div>
        )}

      </main>
    </div>
  );
};

export default App;