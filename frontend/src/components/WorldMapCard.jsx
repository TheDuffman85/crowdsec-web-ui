import { useMemo } from 'react';
import {
    ComposableMap,
    Geographies,
    Geography,
    ZoomableGroup
} from 'react-simple-maps';
import { scaleLinear } from 'd3-scale';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Globe } from 'lucide-react';

// Using local Natural Earth data which has proper ISO properties
const geoUrl = "/world-110m.json";

/**
 * World Map Component for Dashboard
 * Shows all countries with alerts colored in red gradient based on intensity
 */
export function WorldMapCard({ data, onCountrySelect, selectedCountry }) {
    // Create a map of country code to count for quick lookup
    const { countryDataMap, colorScale } = useMemo(() => {
        const map = {};
        let maxCount = 0;

        data.forEach(item => {
            if (item.countryCode) {
                map[item.countryCode.toUpperCase()] = item.count;
                if (item.count > maxCount) maxCount = item.count;
            }
        });

        const scale = scaleLinear()
            .domain([1, maxCount > 1 ? maxCount : 10]) // Use 1 as min to keep 0 gray
            .range(['#fca5a5', '#7f1d1d']); // Tailwind red-300 to red-900

        return { countryDataMap: map, colorScale: scale };
    }, [data]);

    return (
        <Card className="h-full flex flex-col overflow-hidden">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Globe className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                    World Map
                </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col overflow-hidden">
                {data.length === 0 ? (
                    <div className="w-full h-full flex items-center justify-center text-gray-500">
                        No country data available
                    </div>
                ) : (
                    <div className="w-full h-full flex items-start justify-center overflow-hidden">
                        <ComposableMap
                            projectionConfig={{
                                scale: 200
                            }}
                            className="w-full h-auto"
                            style={{ maxHeight: '100%', maxWidth: '100%' }}
                        >
                            <ZoomableGroup center={[0, 0]} zoom={1}>
                                <Geographies geography={geoUrl}>
                                    {({ geographies }) =>
                                        geographies.map((geo) => {
                                            const props = geo.properties || {};
                                            // Try ISO_A2, iso_a2, ADM0_A3 (convert to A2), or name mapping
                                            let alpha2Code = (props.ISO_A2 || props.iso_a2 || props.WB_A2)?.toUpperCase();

                                            const count = alpha2Code ? (countryDataMap[alpha2Code] || 0) : 0;
                                            const isSelected = alpha2Code && selectedCountry?.toUpperCase() === alpha2Code;
                                            const hasAlerts = count > 0;

                                            return (
                                                <Geography
                                                    key={geo.rsmKey}
                                                    geography={geo}
                                                    fill={hasAlerts ? colorScale(count) : '#E5E7EB'}
                                                    stroke={'#fff'}
                                                    strokeWidth={0.5}
                                                    style={{
                                                        default: {
                                                            outline: 'none',
                                                            opacity: isSelected ? 1 : (selectedCountry ? 0.3 : 1)
                                                        },
                                                        hover: {
                                                            fill: hasAlerts ? colorScale(count) : '#D1D5DB', // Keep same color on hover, slightly darker handled by opacity or just keep it
                                                            filter: hasAlerts ? 'brightness(0.9)' : 'none', // Darken slightly on hover
                                                            outline: 'none',
                                                            cursor: hasAlerts ? 'pointer' : 'default',
                                                            opacity: 1,
                                                            stroke: '#fff',
                                                            strokeWidth: 0.5
                                                        },
                                                        pressed: {
                                                            outline: 'none'
                                                        }
                                                    }}
                                                    onClick={() => {
                                                        if (hasAlerts && alpha2Code) {
                                                            onCountrySelect(alpha2Code);
                                                        }
                                                    }}
                                                >
                                                    <title>
                                                        {props.NAME || props.name || 'Unknown'}: {count.toLocaleString()} alerts
                                                    </title>
                                                </Geography>
                                            );
                                        })
                                    }
                                </Geographies>
                            </ZoomableGroup>
                        </ComposableMap>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
