import { useState, useEffect, useMemo, useRef, useLayoutEffect, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Choropleth, type ChoroplethBoundFeature } from '@nivo/geo';
import { geoNaturalEarth1 } from 'd3-geo';
import {
    TransformWrapper,
    TransformComponent,
    type ReactZoomPanPinchContentRef,
    type ReactZoomPanPinchRef,
} from 'react-zoom-pan-pinch';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Switch } from './ui/Switch';
import { Globe, ZoomIn, ZoomOut, RotateCcw, ShieldAlert, Gavel, MapPin } from 'lucide-react';
import { assetUrl } from '../lib/basePath';
import type { DashboardAttackLocationDatum, WorldMapDatum } from '../types';
import { DASHBOARD_COLORS } from '../lib/dashboardColors';
import { useI18n } from '../lib/i18n';
import { getCountryName } from '../lib/utils';
import { CountryFlag } from './CountryFlag';

// Using local Natural Earth data which has proper ISO properties
const geoUrl = assetUrl("/world-50m.json");
const MAP_ANIMATION_STORAGE_KEY = 'crowdsec-web-ui:dashboard:map-animation-enabled';

function setAttackMarkerVisualScale(element: SVGSVGElement | null, scale: number): void {
    if (!element || scale <= 0 || !Number.isFinite(scale)) return;

    const inverseScale = 1 / scale;
    element.style.setProperty('--world-map-attack-pulse-radius', `${3 * inverseScale}px`);
    element.style.setProperty('--world-map-attack-pulse-outline-stroke', `${2.5 * inverseScale}px`);
    element.style.setProperty('--world-map-attack-pulse-stroke', `${1 * inverseScale}px`);
    element.style.setProperty('--world-map-attack-dot-radius', `${2.5 * inverseScale}px`);
    element.style.setProperty('--world-map-attack-dot-stroke', `${0.75 * inverseScale}px`);
}

interface GeoFeatureProperties {
    NAME?: string;
    ISO_A2?: string;
    iso_a2?: string;
    ISO_A2_EH?: string;
    WB_A2?: string;
    [key: string]: unknown;
}

interface GeoFeature {
    id: string;
    label?: string;
    properties: GeoFeatureProperties;
    [key: string]: unknown;
}

interface GeoJsonResponse {
    features?: Array<{
        id?: string;
        properties?: GeoFeatureProperties;
        [key: string]: unknown;
    }>;
}

interface TooltipPosition {
    x: number;
    y: number;
}

interface AttackMarker {
    latitude: number;
    longitude: number;
    count: number;
    city?: string;
    region?: string;
    countryCode?: string;
    x: number;
    y: number;
}

interface WorldMapCardProps {
    data: WorldMapDatum[];
    attackLocations?: DashboardAttackLocationDatum[];
    onCountrySelect: (countryCode: string) => void;
    selectedCountry: string | null;
    simulationsEnabled?: boolean;
}

let geoFeaturesPromise: Promise<GeoFeature[]> | null = null;

function loadGeoFeatures(): Promise<GeoFeature[]> {
    if (geoFeaturesPromise) {
        return geoFeaturesPromise;
    }

    geoFeaturesPromise = fetch(geoUrl)
        .then((response) => {
            if (!response.ok) {
                throw new Error(`Failed to load map data: ${response.status}`);
            }
            return response.json() as Promise<GeoJsonResponse>;
        })
        .then((payload) => {
            const seenCodes = new Set<string>();
            return (payload.features || [])
                .filter((feature) => feature.properties?.ISO_A2 !== 'AQ' && feature.properties?.NAME !== 'Antarctica')
                .map(feature => {
                    const properties = feature.properties || {};
                    const candidates = [
                        properties.ISO_A2,
                        properties.iso_a2,
                        properties.ISO_A2_EH,
                        properties.WB_A2
                    ];

                    let validCode: string | null = null;
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
                .filter((feature): feature is GeoFeature => typeof feature.id === 'string' && feature.id.length > 0)
                .filter((feature) => {
                    if (seenCodes.has(feature.id)) {
                        return false;
                    }
                    seenCodes.add(feature.id);
                    return true;
                });
        })
        .catch((error) => {
            geoFeaturesPromise = null;
            throw error;
        });

    return geoFeaturesPromise;
}

function getFeatureCountryCode(feature: ChoroplethBoundFeature): string {
    const dataId = feature.data && typeof feature.data.id === 'string' ? feature.data.id : '';
    const featureId = 'id' in feature && typeof feature.id === 'string' ? feature.id : '';
    return (dataId || featureId).toUpperCase();
}

/**
 * World Map Component for Dashboard
 * Shows all countries with alerts colored in red gradient based on intensity
 */
export function WorldMapCard({
    data,
    attackLocations = [],
    onCountrySelect,
    selectedCountry,
    simulationsEnabled = false,
}: WorldMapCardProps) {
    const { language, t } = useI18n();
    const [geoFeatures, setGeoFeatures] = useState<GeoFeature[]>([]);
    const [isLoadingStats, setIsLoadingStats] = useState(true);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
    const [initialScale, setInitialScale] = useState(() => window.innerWidth < 800 ? 0.7 : 1.0);
    const mapTransformScaleRef = useRef(initialScale);
    const [tooltipEnabled, setTooltipEnabled] = useState(true);
    const [animationEnabled, setAnimationEnabled] = useState(
        () => window.localStorage.getItem(MAP_ANIMATION_STORAGE_KEY) !== 'false',
    );
    const previousSelectedCountryRef = useRef<string | null>(selectedCountry);
    const touchTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const tooltipRef = useRef<HTMLDivElement | null>(null);
    const attackMarkerOverlayRef = useRef<SVGSVGElement | null>(null);
    const tooltipPositionRef = useRef<TooltipPosition>({ x: 0, y: 0 });
    const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden');
    const [hoveredAttackMarker, setHoveredAttackMarker] = useState<AttackMarker | null>(null);

    useEffect(() => {
        window.localStorage.setItem(MAP_ANIMATION_STORAGE_KEY, String(animationEnabled));
    }, [animationEnabled]);

    useEffect(() => {
        if (!animationEnabled) return;

        const handleVisibilityChange = () => {
            setDocumentVisible(document.visibilityState !== 'hidden');
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, [animationEnabled]);

    const hideTooltip = useCallback(() => {
        setTooltipEnabled((current) => current ? false : current);
        setHoveredAttackMarker(null);
    }, []);

    const showTooltipSoon = useCallback(() => {
        if (touchTooltipTimerRef.current) {
            clearTimeout(touchTooltipTimerRef.current);
        }

        touchTooltipTimerRef.current = setTimeout(() => {
            setTooltipEnabled(true);
            touchTooltipTimerRef.current = null;
        }, 100);
    }, []);

    const updateTooltipPosition = useCallback((clientX: number, clientY: number) => {
        const nextPosition = { x: clientX + 15, y: clientY + 15 };
        tooltipPositionRef.current = nextPosition;

        if (tooltipRef.current) {
            tooltipRef.current.style.left = `${nextPosition.x}px`;
            tooltipRef.current.style.top = `${nextPosition.y}px`;
        }
    }, []);

    // Handle interaction events to hide tooltip - use WINDOW level to guarantee capture
    useEffect(() => {
        // Catch ALL touchmove events at window level (captures map panning, page scrolling, everything)
        const handleTouchMove = () => {
            hideTooltip();
        };

        // Catch page scroll events
        const handleScroll = () => {
            hideTooltip();
        };

        // Handle touchend to re-enable tooltip for NEXT tap (not auto-show)
        const handleTouchEnd = () => {
            showTooltipSoon();
        };

        // Use capture:true AND attach to window to guarantee we see these events
        window.addEventListener('touchmove', handleTouchMove, { passive: true, capture: true });
        window.addEventListener('scroll', handleScroll, { passive: true, capture: true });
        window.addEventListener('touchend', handleTouchEnd, { passive: true, capture: true });

        return () => {
            window.removeEventListener('touchmove', handleTouchMove, { capture: true });
            window.removeEventListener('scroll', handleScroll, { capture: true });
            window.removeEventListener('touchend', handleTouchEnd, { capture: true });
            if (touchTooltipTimerRef.current) {
                clearTimeout(touchTooltipTimerRef.current);
                touchTooltipTimerRef.current = null;
            }
        };
    }, [hideTooltip, showTooltipSoon]);
    // Tooltip Component to be rendered by Nivo
    const MapTooltip = ({ feature }: { feature: ChoroplethBoundFeature }) => {
        useLayoutEffect(() => {
            if (!tooltipRef.current) {
                return;
            }

            const { x, y } = tooltipPositionRef.current;
            tooltipRef.current.style.left = `${x}px`;
            tooltipRef.current.style.top = `${y}px`;
        }, []);

        if (!feature || !tooltipEnabled) return null;

        // Find alert data locally since Nivo only passes the feature props
        const featureId = getFeatureCountryCode(feature);
        const isDimmedByCountryFilter = selectedCountry !== null && selectedCountry !== featureId;
        const showMetricRows = !isDimmedByCountryFilter && (feature.data !== undefined || selectedCountry === featureId);
        const approximateLocation = hoveredAttackMarker
            ? [
                hoveredAttackMarker.city,
                hoveredAttackMarker.region,
                getCountryName(hoveredAttackMarker.countryCode, language),
            ].reduce<string[]>((parts, part) => {
                if (part && !parts.some((current) => current.toLocaleLowerCase(language) === part.toLocaleLowerCase(language))) {
                    parts.push(part);
                }
                return parts;
            }, []).join(', ')
            : '';

        return createPortal(
            <div
                ref={tooltipRef}
                data-testid="world-map-tooltip"
                className="fixed z-[99999] pointer-events-none max-[799px]:hidden bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 shadow-xl rounded-lg p-3 text-sm max-w-[260px]"
            >
                <div className={`flex items-center gap-2 font-medium ${showMetricRows || hoveredAttackMarker ? 'mb-2' : ''}`}>
                    <CountryFlag code={featureId} />
                    <span className="min-w-0">
                        {getCountryName(featureId, language) ?? feature.label ?? featureId}
                    </span>
                </div>
                {showMetricRows && (
                    <>
                        <div className="flex items-center gap-2">
                            <ShieldAlert className="w-4 h-4" style={{ color: DASHBOARD_COLORS.liveAlerts }} />
                            <span className="whitespace-nowrap" style={{ color: DASHBOARD_COLORS.liveAlerts }}>
                                {t('components.worldMap.alerts')}: {Number(feature.data?.liveCount || 0).toLocaleString()}
                                {hoveredAttackMarker && (
                                    <> ({t('components.worldMap.locationCount', { count: hoveredAttackMarker.count })})</>
                                )}
                            </span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                            <Gavel className="w-4 h-4" style={{ color: DASHBOARD_COLORS.liveDecisions }} />
                            <span style={{ color: DASHBOARD_COLORS.liveDecisions }}>
                                {t('components.dashboardCharts.decisions')}: {Number(feature.data?.liveDecisionCount || 0).toLocaleString()}
                                {' '}({Number(feature.data?.activeLiveDecisionCount || 0).toLocaleString()} {t('common.active').toLocaleLowerCase(language)})
                            </span>
                        </div>
                        {simulationsEnabled && Number(feature.data?.simulatedCount || 0) > 0 && (
                            <div className="mt-1 flex items-center gap-2">
                                <ShieldAlert className="w-4 h-4" style={{ color: DASHBOARD_COLORS.simulatedAlerts }} />
                                <span style={{ color: DASHBOARD_COLORS.simulatedAlerts }}>
                                    {t('components.worldMap.simulationAlerts')}: {Number(feature.data?.simulatedCount || 0).toLocaleString()}
                                </span>
                            </div>
                        )}
                        {simulationsEnabled && Number(feature.data?.simulatedDecisionCount || 0) > 0 && (
                            <div className="mt-1 flex items-center gap-2">
                                <Gavel className="w-4 h-4" style={{ color: DASHBOARD_COLORS.simulatedDecisions }} />
                                <span style={{ color: DASHBOARD_COLORS.simulatedDecisions }}>
                                    {t('components.dashboardCharts.simulationDecisions')}: {Number(feature.data?.simulatedDecisionCount || 0).toLocaleString()}
                                    {' '}({Number(feature.data?.activeSimulatedDecisionCount || 0).toLocaleString()} {t('common.active').toLocaleLowerCase(language)})
                                </span>
                            </div>
                        )}
                    </>
                )}
                {hoveredAttackMarker && approximateLocation && (
                    <div
                        data-testid="world-map-attack-location"
                        className="mt-2 flex items-start gap-1.5 border-t border-gray-200 pt-2 text-gray-500 dark:border-gray-700 dark:text-gray-400"
                    >
                        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <div className="min-w-0">
                            <div className="text-[10px] font-medium uppercase tracking-wide">
                                {t('components.worldMap.approximateLocation')}
                            </div>
                            <div className="mt-0.5 text-xs font-medium text-gray-700 dark:text-gray-200">
                                {approximateLocation}
                            </div>
                        </div>
                    </div>
                )}
            </div>,
            document.body
        );
    };

    // Track container size for dynamic map scaling
    useLayoutEffect(() => {
        if (!containerRef.current) return;

        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                setDimensions({ width, height });
            }
        });

        resizeObserver.observe(containerRef.current);
        return () => resizeObserver.disconnect();
    }, []);

    const transformComponentRef = useRef<ReactZoomPanPinchRef | null>(null);

    // Add viewport resize handler to reset zoom
    useEffect(() => {
        const handleResize = () => {
            if (transformComponentRef.current) {
                const { centerView } = transformComponentRef.current;
                if (centerView) {
                    // Reset to the appropriate zoom level for the new viewport size
                    const newZoomScale = window.innerWidth > 0 && window.innerWidth < 800 ? 0.7 : 1.0;
                    setInitialScale(newZoomScale);
                    centerView(newZoomScale, 0);
                }
            }
        };

        let resizeTimer: ReturnType<typeof setTimeout> | undefined;
        const debouncedResize = () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(handleResize, 300);
        };

        window.addEventListener('resize', debouncedResize);
        return () => {
            window.removeEventListener('resize', debouncedResize);
            clearTimeout(resizeTimer);
        };
    }, []);

    // Calculate responsive map dimensions based on container size
    // Maintain 16:9 aspect ratio while fitting within container
    const BASE_WIDTH = 800;
    const BASE_HEIGHT = 450;
    const BASE_PROJECTION_SCALE = 120;

    const { mapWidth, mapHeight, projectionScale } = useMemo(() => {
        if (dimensions.width === 0 || dimensions.height === 0) {
            // Fallback before first measurement
            return {
                mapWidth: BASE_WIDTH,
                mapHeight: BASE_HEIGHT,
                projectionScale: BASE_PROJECTION_SCALE
            };
        }

        // Use the actual container dimensions, but maintain aspect ratio
        // The map should fit entirely within the container
        const containerWidth = dimensions.width;
        const containerHeight = dimensions.height;
        const aspectRatio = BASE_WIDTH / BASE_HEIGHT;

        let width, height;

        // Calculate dimensions that fit within container while maintaining aspect ratio
        if (containerWidth / containerHeight > aspectRatio) {
            // Container is wider than aspect ratio - constrain by height
            height = containerHeight;
            width = height * aspectRatio;
        } else {
            // Container is taller than aspect ratio - constrain by width
            width = containerWidth;
            height = width / aspectRatio;
        }

        // Calculate scale factor for projection
        const scaleFactor = width / BASE_WIDTH;
        // Add padding factor for mobile viewports to ensure map fits with margins
        const paddingFactor = width < 800 ? 0.70 : 0.95;
        const newProjectionScale = BASE_PROJECTION_SCALE * scaleFactor * paddingFactor;

        return {
            mapWidth: Math.max(width, 200), // Minimum width of 200px
            mapHeight: Math.max(height, 112.5), // Minimum height maintaining aspect ratio
            projectionScale: Math.max(newProjectionScale, 30) // Minimum projection scale
        };
    }, [dimensions.width, dimensions.height]);

    // Fetch and process map data once, including across development StrictMode remounts.
    useEffect(() => {
        let active = true;

        loadGeoFeatures()
            .then((features) => {
                if (!active) return;
                setGeoFeatures(features);
                setIsLoadingStats(false);
            })
            .catch((err: unknown) => {
                if (!active) return;
                console.error("Failed to load map data", err);
                setIsLoadingStats(false);
            });

        return () => {
            active = false;
        };
    }, []);

    // Build nivoData
    const nivoData = useMemo(() => {
        return data.map(item => ({
            id: item.countryCode ? item.countryCode.toUpperCase() : 'UNKNOWN',
            value: item.count || 0,
            liveCount: item.liveCount ?? Math.max((item.count || 0) - (item.simulatedCount || 0), 0),
            simulatedCount: item.simulatedCount || 0,
            liveDecisionCount: item.liveDecisionCount || 0,
            simulatedDecisionCount: item.simulatedDecisionCount || 0,
            activeLiveDecisionCount: item.activeLiveDecisionCount || 0,
            activeSimulatedDecisionCount: item.activeSimulatedDecisionCount || 0,
        }));
    }, [data]);

    // Calculate max value
    const maxCount = useMemo(() => {
        return Math.max(...data.map(d => d.count), 0);
    }, [data]);

    const attackMarkers = useMemo<AttackMarker[]>(() => {
        if (!animationEnabled || geoFeatures.length === 0) return [];

        const projection = geoNaturalEarth1()
            .scale(projectionScale)
            .translate([mapWidth / 2, mapHeight / 2])
            .rotate([0, 0, 0]);
        const markers: AttackMarker[] = [];

        attackLocations.forEach((location) => {
            if (location.count <= 0) return;

            const longitude = Number(location.longitude);
            const latitude = Number(location.latitude);
            if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
            if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return;

            const point = projection([longitude, latitude]);
            if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;

            markers.push({
                latitude,
                longitude,
                count: location.count,
                city: location.city,
                region: location.region,
                countryCode: location.countryCode,
                x: point[0],
                y: point[1],
            });
        });

        return markers;
    }, [animationEnabled, attackLocations, geoFeatures.length, mapHeight, mapWidth, projectionScale]);

    const updateHoveredAttackMarker = useCallback((clientX: number, clientY: number) => {
        const overlay = attackMarkerOverlayRef.current;
        if (!overlay || attackMarkers.length === 0) {
            setHoveredAttackMarker(null);
            return;
        }

        const bounds = overlay.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) {
            setHoveredAttackMarker(null);
            return;
        }

        const hitRadius = 8;
        let closestMarker: AttackMarker | null = null;
        let closestDistanceSquared = hitRadius * hitRadius;

        for (const marker of attackMarkers) {
            const markerClientX = bounds.left + (marker.x / mapWidth) * bounds.width;
            const markerClientY = bounds.top + (marker.y / mapHeight) * bounds.height;
            const deltaX = clientX - markerClientX;
            const deltaY = clientY - markerClientY;
            const distanceSquared = deltaX * deltaX + deltaY * deltaY;

            if (distanceSquared <= closestDistanceSquared) {
                closestMarker = marker;
                closestDistanceSquared = distanceSquared;
            }
        }

        setHoveredAttackMarker((current) => current === closestMarker ? current : closestMarker);
    }, [attackMarkers, mapHeight, mapWidth]);

    const isFiltered = selectedCountry !== null && selectedCountry !== undefined;

    // Handle selection visual state manually with robust DOM selector
    useEffect(() => {
        const previousSelectedCountry = previousSelectedCountryRef.current;
        previousSelectedCountryRef.current = selectedCountry;

        if (!selectedCountry && !previousSelectedCountry) {
            return;
        }
        if (!containerRef.current || geoFeatures.length === 0) return;

        const animationFrameId = window.requestAnimationFrame(() => {
            // Select ONLY paths that have a fill attribute and are NOT 'none' (this implies they are feature paths, not graticules)
            // Nivo graticules usually have fill="none".
            // Features have a color fill.
            // Using Array.from to filter ensures we target the right elements.
            const containerElement = containerRef.current;
            if (!containerElement) return;

            const allPaths = Array.from(containerElement.querySelectorAll<SVGPathElement>('path'));
            const featurePaths = allPaths.filter((path) => {
                const fill = path.getAttribute('fill');
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
                        path.style.stroke = '#38bdf8';
                        path.style.strokeWidth = '1.5';
                        path.style.strokeLinejoin = 'round';
                        path.style.filter = 'drop-shadow(0 0 4px rgba(56, 189, 248, 0.65))';
                    } else {
                        path.setAttribute('data-status', 'dimmed');
                        path.style.opacity = '0.3';
                        path.style.stroke = '';
                        path.style.strokeWidth = '';
                        path.style.strokeLinejoin = '';
                        path.style.filter = '';
                    }
                } else {
                    path.removeAttribute('data-status');
                    path.style.opacity = '1';
                    path.style.stroke = '';
                    path.style.strokeWidth = '';
                    path.style.strokeLinejoin = '';
                    path.style.filter = '';
                }
            });
        });

        return () => window.cancelAnimationFrame(animationFrameId);
    }, [selectedCountry, geoFeatures, isLoadingStats]);

    return (
        <Card className="h-full flex flex-col overflow-hidden">
            <CardHeader className="flex items-center justify-between gap-4">
                <CardTitle className="flex items-center gap-2">
                    <Globe className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                    {t('components.worldMap.title')}
                </CardTitle>
                <div className="flex items-center gap-2">
                    <label
                        id="world-map-attack-markers-label"
                        htmlFor="world-map-attack-markers-toggle"
                        className="whitespace-nowrap text-xs font-medium text-gray-600 dark:text-gray-300"
                    >
                        {t('components.worldMap.attackMarkers')}
                    </label>
                    <Switch
                        id="world-map-attack-markers-toggle"
                        checked={animationEnabled}
                        onCheckedChange={setAnimationEnabled}
                        ariaLabelledBy="world-map-attack-markers-label"
                    />
                </div>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col overflow-hidden relative !p-0">
                {isLoadingStats ? (
                    <div className="w-full h-full flex items-center justify-center text-gray-500">
                        {t('common.loadingMap')}
                    </div>
                ) : (
                    <div
                        ref={containerRef}
                        className={`w-full h-full absolute inset-0 world-map-container ${isFiltered ? 'country-filtered' : ''}`}
                        onPointerMoveCapture={(event) => {
                            updateTooltipPosition(event.clientX, event.clientY);
                            updateHoveredAttackMarker(event.clientX, event.clientY);
                        }}
                        onPointerLeave={() => setHoveredAttackMarker(null)}
                    >
                        <style>{`
                            .world-map-container path {
                                transition: opacity 0.2s ease, filter 0.15s ease, stroke-width 0.15s ease;
                                cursor: pointer;
                                outline: none !important;
                            }
                            .world-map-container path:hover {
                                filter: brightness(0.85);
                                opacity: 1 !important;
                            }
                            /* Fallback styles if JS fails */
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
                            ref={transformComponentRef}
                            initialScale={initialScale}
                            minScale={Math.max(0.1, initialScale - 0.25)}
                            maxScale={8}
                            centerOnInit={true}
                            centerZoomedOut={false}
                            smooth={false}
                            wheel={{ step: 0.15 }}
                            panning={{ velocityDisabled: true }}
                            doubleClick={{ mode: 'zoomIn', step: 0.7 }}
                            limitToBounds={false}
                            onTransform={(_ref, state) => {
                                if (state.scale > 0 && Number.isFinite(state.scale)) {
                                    mapTransformScaleRef.current = state.scale;
                                    setAttackMarkerVisualScale(attackMarkerOverlayRef.current, state.scale);
                                }
                            }}
                            onPanning={() => {
                                // Hide tooltip only when actual panning occurs
                                hideTooltip();
                            }}
                            onPanningStop={(ref: ReactZoomPanPinchRef) => {
                                // Re-enable tooltip after panning stops
                                showTooltipSoon();
                                // Rubberband effect: check if map is panned outside visible area
                                if (!containerRef.current) return;

                                const containerRect = containerRef.current.getBoundingClientRect();
                                const { state } = ref;
                                const { positionX, positionY, scale } = state;

                                // Calculate the scaled map dimensions
                                const scaledWidth = mapWidth * scale;
                                const scaledHeight = mapHeight * scale;

                                // Calculate bounds - ensure at least some part of the map is visible
                                const minVisiblePortion = 300; // pixels
                                const maxX = containerRect.width - minVisiblePortion;
                                const minX = -(scaledWidth - minVisiblePortion);
                                const maxY = containerRect.height - minVisiblePortion;
                                const minY = -(scaledHeight - minVisiblePortion);

                                // Check if map is outside bounds
                                const isOutOfBounds =
                                    positionX > maxX ||
                                    positionX < minX ||
                                    positionY > maxY ||
                                    positionY < minY;

                                if (isOutOfBounds) {
                                    // Reset to center if out of bounds
                                    ref.centerView(initialScale, 300, "easeOut");
                                }
                            }}
                        >
                            {(controls: ReactZoomPanPinchContentRef) => (
                                <>
                                    <div className="absolute top-2 right-2 z-10 flex flex-col gap-1">
                                        <button onClick={() => controls.zoomIn()} className="p-1.5 bg-white dark:bg-gray-800 rounded shadow-md border dark:border-gray-600" aria-label={t('components.worldMap.zoomIn')} title={t('components.worldMap.zoomIn')}>
                                            <ZoomIn className="w-4 h-4 text-gray-600 dark:text-gray-300" />
                                        </button>
                                        <button onClick={() => controls.zoomOut()} className="p-1.5 bg-white dark:bg-gray-800 rounded shadow-md border dark:border-gray-600" aria-label={t('components.worldMap.zoomOut')} title={t('components.worldMap.zoomOut')}>
                                            <ZoomOut className="w-4 h-4 text-gray-600 dark:text-gray-300" />
                                        </button>
                                        <button
                                            onClick={() => controls.centerView(initialScale, 300)}
                                            className="p-1.5 bg-white dark:bg-gray-800 rounded shadow-md border dark:border-gray-600"
                                            aria-label={t('components.worldMap.resetView')}
                                            title={t('components.worldMap.resetView')}
                                        >
                                            <RotateCcw className="w-4 h-4 text-gray-600 dark:text-gray-300" />
                                        </button>
                                    </div>
                                            <TransformComponent wrapperStyle={{ width: '100%', height: '100%' }} contentStyle={{ width: '100%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                                        <div className="relative" style={{ width: mapWidth, height: mapHeight }}>
                                            <Choropleth
                                                width={mapWidth}
                                                height={mapHeight}
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
                                                onClick={(feature) => {
                                                    const featureId = getFeatureCountryCode(feature);
                                                    if (featureId) {
                                                        onCountrySelect(featureId);
                                                    }
                                                }}
                                                tooltip={MapTooltip}
                                            />
                                            {animationEnabled && attackMarkers.length > 0 && (
                                                <svg
                                                    ref={attackMarkerOverlayRef}
                                                    className={`pointer-events-none absolute inset-0 ${documentVisible ? '' : 'world-map-attack-markers-paused'}`}
                                                    width={mapWidth}
                                                    height={mapHeight}
                                                    viewBox={`0 0 ${mapWidth} ${mapHeight}`}
                                                    style={{
                                                        '--world-map-attack-pulse-radius': `${3 / mapTransformScaleRef.current}px`,
                                                        '--world-map-attack-pulse-outline-stroke': `${2.5 / mapTransformScaleRef.current}px`,
                                                        '--world-map-attack-pulse-stroke': `${1 / mapTransformScaleRef.current}px`,
                                                        '--world-map-attack-dot-radius': `${2.5 / mapTransformScaleRef.current}px`,
                                                        '--world-map-attack-dot-stroke': `${0.75 / mapTransformScaleRef.current}px`,
                                                    } as CSSProperties}
                                                    aria-hidden="true"
                                                    data-testid="world-map-attack-markers"
                                                >
                                                    {attackMarkers.map((marker, index) => (
                                                        <g
                                                            key={`${marker.latitude}:${marker.longitude}`}
                                                            data-latitude={marker.latitude}
                                                            data-longitude={marker.longitude}
                                                            transform={`translate(${marker.x} ${marker.y})`}
                                                        >
                                                            <circle
                                                                className="world-map-attack-pulse world-map-attack-pulse-outline"
                                                                r="3"
                                                                fill="none"
                                                                stroke="#7f1d1d"
                                                                strokeWidth="2.5"
                                                                style={{ animationDelay: `${-(index % 11) * 0.17}s` }}
                                                            />
                                                            <circle
                                                                className="world-map-attack-pulse"
                                                                r="3"
                                                                fill="none"
                                                                stroke="#ffffff"
                                                                strokeWidth="1"
                                                                style={{ animationDelay: `${-(index % 11) * 0.17}s` }}
                                                            />
                                                            <circle
                                                                className="world-map-attack-dot"
                                                                r="2.5"
                                                                fill="#dc2626"
                                                                stroke="#ffffff"
                                                                strokeWidth="0.75"
                                                            />
                                                        </g>
                                                    ))}
                                                </svg>
                                            )}
                                        </div>
                                    </TransformComponent>
                                </>
                            )}
                        </TransformWrapper>
                    </div>
                )}
            </CardContent>
        </Card >
    );
}
