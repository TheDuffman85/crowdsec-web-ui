import React from 'react';

export function Switch({ checked, onCheckedChange, id }) {
    return (
        <button
            id={id}
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onCheckedChange(!checked)}
            className={`
                relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent 
                transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 
                focus-visible:ring-primary-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white 
                dark:focus-visible:ring-offset-gray-950
                ${checked ? 'bg-primary-600' : 'bg-gray-200 dark:bg-gray-700'}
            `}
        >
            <span
                className={`
                    pointer-events-none block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 
                    transition duration-200 ease-in-out
                    ${checked ? 'translate-x-5' : 'translate-x-0'}
                `}
            />
        </button>
    );
}
