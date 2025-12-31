import { useState, useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { ResponsiveChoropleth } from '@nivo/geo';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Globe, ZoomIn, ZoomOut, RotateCcw, ShieldAlert } from 'lucide-react';

// Using local Natural Earth data which has proper ISO properties
const geoUrl = "/world-50m.json";

/**
 * World Map Component for Dashboard
 * Shows all countries with alerts colored in red gradient based on intensity
 */
export function WorldMapCard({ data, onCountrySelect, selectedCountry }) {
    const [geoFeatures, setGeoFeatures] = useState([]);
    const [isLoadingStats, setIsLoadingStats] = useState(true);
    const containerRef = useRef(null);
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

    // Refs for tooltip positioning
    const tooltipRef = useRef(null);
    const mousePosRef = useRef({ x: 0, y: 0, clientX: 0, clientY: 0 });

    // Track mouse position GLOBALLY to ensure we always have coordinates
    useEffect(() => {
        const handleMouseMove = (e) => {
            // Update ref for initial position of new tooltips
            mousePosRef.current = {
                x: e.pageX,
                y: e.pageY,
                clientX: e.clientX,
                clientY: e.clientY
            };

            // If a tooltip is currently active, move it immediately
            if (tooltipRef.current) {
                const x = e.pageX + 15;
                const y = e.pageY + 15;
                tooltipRef.current.style.left = `${x}px`;
                tooltipRef.current.style.top = `${y}px`;
            }
        };

        window.addEventListener('mousemove', handleMouseMove, { capture: true });
        return () => window.removeEventListener('mousemove', handleMouseMove, { capture: true });
    }, []);

    // Tooltip Component to be rendered by Nivo
    const PortalTooltip = ({ feature }) => {
        // useLayoutEffect ensures position is set BEFORE paint
        useLayoutEffect(() => {
            if (tooltipRef.current) {
                const { x, y } = mousePosRef.current;
                tooltipRef.current.style.left = `${x + 15}px`;
                tooltipRef.current.style.top = `${y + 15}px`;
            }
        }, []);

        if (!feature) return null;

        // Find alert data locally since Nivo only passes the feature props
        const alertData = data.find(d => d.countryCode?.toUpperCase() === feature.id);
        const value = alertData?.count || 0;

        return createPortal(
            <div
                ref={tooltipRef}
                className="fixed z-[99999] pointer-events-none bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 shadow-xl rounded-lg p-3 text-sm max-w-[200px]"
                style={{
                    left: 0,
                    top: 0,
                    // transform is handled by refs in parent via style.left/top
                }}
            >
                <div className="font-medium mb-2">
                    {feature.properties?.NAME || feature.label || feature.id}
                </div>
                <div className="flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-red-600 dark:text-red-400" />
                    <span className="text-gray-700 dark:text-gray-300">
                        Alerts: {value > 0 ? value.toLocaleString() : 0}
                    </span>
                </div>
            </div>,
            document.body
        );
    };

    // Track container size for dynamic map scaling
    useLayoutEffect(() => {
        if (!containerRef.current) return;

        const resizeObserver = new ResizeObserver((entries) => {
            for (let entry of entries) {
                const { width, height } = entry.contentRect;
                setDimensions({ width, height });
            }
        });

        resizeObserver.observe(containerRef.current);
        return () => resizeObserver.disconnect();
    }, []);

    // Calculate projection scale
    const projectionScale = useMemo(() => {
        if (dimensions.width === 0 || dimensions.height === 0) return 100;
        return Math.min(dimensions.width / 6.3, dimensions.height / 3.3);
    }, [dimensions.width, dimensions.height]);

    // Fetch and process map data
    useEffect(() => {
        fetch(geoUrl)
            .then(response => response.json())
            .then(data => {
                if (data.features) {
                    const seenCodes = new Set();
                    const processedFeatures = data.features
                        .filter(f => f.properties.ISO_A2 !== 'AQ' && f.properties.NAME !== 'Antarctica')
                        .map(feature => {
                            const properties = feature.properties || {};
                            const candidates = [
                                properties.ISO_A2,
                                properties.iso_a2,
                                properties.ISO_A2_EH,
                                properties.WB_A2,
                                properties.POSTAL
                            ];

                            let validCode = null;
                            for (const code of candidates) {
                                if (code && code !== '-99' && /^[A-Z]{2}$/i.test(String(code))) {
                                    validCode = String(code).toUpperCase();
                                    break;
                                }
                            }

                            return {
                                ...feature,
                                id: validCode || feature.id || properties.NAME
                            };
                        })
                        .filter(feature => {
                            if (seenCodes.has(feature.id)) {
                                return false;
                            }
                            seenCodes.add(feature.id);
                            return true;
                        });
                    setGeoFeatures(processedFeatures);
                }
                setIsLoadingStats(false);
            })
            .catch(err => {
                console.error("Failed to load map data", err);
                setIsLoadingStats(false);
            });
    }, []);

    // Build nivoData
    const nivoData = useMemo(() => {
        return data.map(item => ({
            id: item.countryCode ? item.countryCode.toUpperCase() : 'UNKNOWN',
            value: item.count || 0
        }));
    }, [data]);

    // Calculate max value
    const maxCount = useMemo(() => {
        return Math.max(...data.map(d => d.count), 0);
    }, [data]);

    const isFiltered = selectedCountry !== null && selectedCountry !== undefined;

    // Handle selection visual state manually with robust DOM selector
    useEffect(() => {
        if (!containerRef.current || geoFeatures.length === 0) return;

        // Debounce slightly to ensure render cycle completes
        const timer = setTimeout(() => {
            // Select ONLY paths that have a fill attribute and are NOT 'none' (this implies they are feature paths, not graticules)
            // Nivo graticules usually have fill="none".
            // Features have a color fill.
            // Using Array.from to filter ensures we target the right elements.
            const allPaths = Array.from(containerRef.current.querySelectorAll('path'));
            const featurePaths = allPaths.filter(p => {
                const fill = p.getAttribute('fill');
                return fill && fill !== 'none';
            });

            // Safety check: if count mismatch, don't guess (avoids random highlighting)
            // But we can be lenient if length > geoFeatures (e.g. some artifacts), provided order is stable.
            // SVG order is usually stable: render order.

            if (featurePaths.length < geoFeatures.length) return;

            geoFeatures.forEach((feature, index) => {
                const path = featurePaths[index];
                if (!path) return;

                if (selectedCountry) {
                    if (feature.id === selectedCountry) {
                        path.setAttribute('data-status', 'active');
                        path.style.opacity = '1';
                    } else {
                        path.setAttribute('data-status', 'dimmed');
                        path.style.opacity = '0.3';
                    }
                } else {
                    path.removeAttribute('data-status');
                    path.style.opacity = '1';
                }
            });
        }, 150); // Increased delay slightly to be safe

        return () => clearTimeout(timer);
    }, [selectedCountry, geoFeatures, isLoadingStats, nivoData]); // Added nivoData dependency as re-render changes DOM

    return (
        <Card className="h-full flex flex-col overflow-hidden">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Globe className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                    World Map
                </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col overflow-hidden relative">
                {isLoadingStats ? (
                    <div className="w-full h-full flex items-center justify-center text-gray-500">
                        Loading map...
                    </div>
                ) : (
                    <div
                        ref={containerRef}
                        className={`w-full h-full absolute inset-0 world-map-container ${isFiltered ? 'country-filtered' : ''}`}
                    >
                        <style>{`
                            .world-map-container path {
                                transition: opacity 0.2s ease, filter 0.15s ease;
                                cursor: pointer;
                                outline: none !important;
                            }
                            .world-map-container path:hover {
                                filter: brightness(0.85);
                                opacity: 1 !important;
                            }
                            // Fallback styles if JS fails
                            .world-map-container.country-filtered path {
                                opacity: 0.3;
                            }
                            .world-map-container.country-filtered path[data-status="active"],
                            .world-map-container.country-filtered path:hover {
                                opacity: 1 !important;
                            }
                            .react-transform-wrapper, .react-transform-component {
                                width: 100% !important;
                                height: 100% !important;
                            }
                        `}</style>
                        <TransformWrapper
                            initialScale={1}
                            minScale={0.5}
                            maxScale={8}
                            centerOnInit={true}
                            wheel={{ step: 0.1 }}
                            panning={{ velocityDisabled: true }}
                            doubleClick={{ mode: 'zoomIn', step: 0.7 }}
                        >
                            {({ zoomIn, zoomOut, resetTransform }) => (
                                <>
                                    <div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
                                        <button onClick={() => zoomIn()} className="p-1.5 bg-white dark:bg-gray-800 rounded shadow-md border dark:border-gray-600">
                                            <ZoomIn className="w-4 h-4 text-gray-600 dark:text-gray-300" />
                                        </button>
                                        <button onClick={() => zoomOut()} className="p-1.5 bg-white dark:bg-gray-800 rounded shadow-md border dark:border-gray-600">
                                            <ZoomOut className="w-4 h-4 text-gray-600 dark:text-gray-300" />
                                        </button>
                                        <button onClick={() => resetTransform()} className="p-1.5 bg-white dark:bg-gray-800 rounded shadow-md border dark:border-gray-600">
                                            <RotateCcw className="w-4 h-4 text-gray-600 dark:text-gray-300" />
                                        </button>
                                    </div>
                                    <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }} contentStyle={{ width: '100%', height: '100%' }}>
                                        <div className="w-full h-full" style={{ minWidth: dimensions.width || '100%', minHeight: dimensions.height || '100%' }}>
                                            <ResponsiveChoropleth
                                                data={nivoData}
                                                features={geoFeatures}
                                                margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
                                                colors={['#fca5a5', '#dc2626', '#991b1b', '#7f1d1d']}
                                                domain={[0, maxCount > 0 ? maxCount : 1]}
                                                unknownColor="#E5E7EB"
                                                label="properties.NAME"
                                                valueFormat=","
                                                projectionType="naturalEarth1"
                                                projectionScale={projectionScale}
                                                projectionTranslation={[0.5, 0.5]}
                                                projectionRotation={[0, 0, 0]}
                                                enableGraticule={false}
                                                borderWidth={0.5}
                                                borderColor="#ffffff"
                                                onClick={(feature) => { if (feature && feature.id) onCountrySelect(feature.id); }}
                                                // Revert to standard layers to ensure rendering
                                                layers={['graticule', 'features', 'legends']}
                                                tooltip={PortalTooltip}
                                            />
                                        </div>
                                    </TransformComponent>
                                </>
                            )}
                        </TransformWrapper>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
