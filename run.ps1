param(
    [ValidateSet('normal', 'dev')]
    [string]$Mode = 'normal'
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path $ScriptDir).Path
$EnvFile = Join-Path $ScriptDir '.env'
$BackendPort = 3000
$FrontendPort = 5173

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Write-Host "[$timestamp] $Message"
}

function Stop-ServiceOnPort {
    param(
        [int]$Port,
        [string]$Name
    )

    $pids = @()

    try {
        $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique
        if ($connections) {
            $pids = @($connections)
        }
    } catch {
        $netstatMatches = netstat -ano | Select-String -Pattern "LISTENING\s+(\d+)$"
        foreach ($match in $netstatMatches) {
            $line = $match.Line.Trim() -split '\s+'
            if ($line.Length -ge 5 -and $line[1] -match ":$Port$") {
                $pids += [int]$line[-1]
            }
        }
        $pids = $pids | Select-Object -Unique
    }

    if (-not $pids -or $pids.Count -eq 0) {
        Write-Log "No $Name found on port $Port."
        return
    }

    foreach ($processId in $pids) {
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Write-Log "Stopped $Name running on port $Port (PID: $processId)."
        } catch {
            Write-Log "Failed to stop $Name on port $Port (PID: $processId): $($_.Exception.Message)"
        }
    }
}

function Import-DotEnv {
    param([string]$Path)

    if (-not (Test-Path $Path)) {
        Write-Log "No .env file found at $Path. Proceeding with default environment."
        return
    }

    Write-Log "Loading environment variables from $Path..."

    foreach ($line in Get-Content $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) {
            continue
        }

        $parts = $trimmed -split '=', 2
        if ($parts.Count -ne 2) {
            continue
        }

        $key = $parts[0].Trim()
        $value = $parts[1].Trim()

        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        Set-Item -Path "Env:$key" -Value $value
    }
}

function Assert-BunInstalled {
    $bunCommand = Get-Command bun -ErrorAction SilentlyContinue
    if ($null -eq $bunCommand) {
        Write-Log "Error: 'bun' runtime is not installed."
        Write-Log 'Please install Bun to run this application locally: https://bun.sh'
        Write-Log 'Alternatively, use Docker to run the containerized application.'
        exit 1
    }
}

function Stop-TrackedProcesses {
    param([System.Diagnostics.Process[]]$Processes)

    foreach ($process in $Processes) {
        if ($null -eq $process) {
            continue
        }

        try {
            if (-not $process.HasExited) {
                Stop-Process -Id $process.Id -Force -ErrorAction Stop
                Write-Log "Stopped process $($process.Id)."
            }
        } catch {
            Write-Log "Failed to stop process $($process.Id): $($_.Exception.Message)"
        }
    }
}

Write-Log 'Checking for running services...'
Stop-ServiceOnPort -Port $BackendPort -Name 'backend'
Stop-ServiceOnPort -Port $FrontendPort -Name 'frontend'

Import-DotEnv -Path $EnvFile
Assert-BunInstalled

Set-Location $ProjectRoot

if ($Mode -eq 'dev') {
    Write-Log 'Starting in DEVELOPMENT mode...'
    Write-Log 'Starting backend (bun --watch)...'
    $backend = Start-Process -FilePath 'bun' -ArgumentList 'run', 'dev' -WorkingDirectory $ProjectRoot -PassThru

    Write-Log 'Starting frontend (vite)...'
    $frontend = Start-Process -FilePath 'bun' -ArgumentList 'run', 'dev' -WorkingDirectory (Join-Path $ProjectRoot 'frontend') -PassThru

    Write-Log "Services started. Backend PID: $($backend.Id), Frontend PID: $($frontend.Id)"

    try {
        Wait-Process -Id $backend.Id, $frontend.Id
    } finally {
        Write-Log 'Stopping services...'
        Stop-TrackedProcesses -Processes @($backend, $frontend)
    }
} else {
    Write-Log 'Starting in PRODUCTION mode...'
    Write-Log 'Building frontend...'
    & bun run build-ui

    if ($LASTEXITCODE -ne 0) {
        Write-Log 'Frontend build failed. Aborting.'
        exit $LASTEXITCODE
    }

    Write-Log 'Frontend build successful.'
    Write-Log 'Starting backend...'
    & bun start
    exit $LASTEXITCODE
}
