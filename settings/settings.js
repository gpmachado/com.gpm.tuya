var homeyApi = null;
var devices = [];
var currentSort = 'name-asc';
var latestRequest = 0;
var latestAvailabilityRequest = 0;
var resetInFlight = false;
var activeTab = 'traffic';

function translate(key) {
  if (homeyApi && typeof homeyApi.__ === 'function') return homeyApi.__(key);
  return key;
}

function userLocale() {
  return navigator.language || 'en';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatNumber(value) {
  return new Intl.NumberFormat(userLocale()).format(Number(value) || 0);
}

function formatTime(timestamp) {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat(userLocale(), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(timestamp));
}

function formatDate(timestamp) {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat(userLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(new Date(timestamp));
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(function(button) {
    var isActive = button.getAttribute('data-tab') === tab;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });
  document.getElementById('panel-traffic').hidden = tab !== 'traffic';
  document.getElementById('panel-rejoins').hidden = tab !== 'rejoins';
}

function compareDevices(a, b) {
  var parts = currentSort.split('-');
  var direction = parts.pop();
  var field = parts.join('-');
  var multiplier = direction === 'asc' ? 1 : -1;

  if (field === 'name') {
    return a.name.localeCompare(b.name, userLocale(), { sensitivity: 'base' }) * multiplier;
  }
  var aValue = field === 'lastMessageAt' ? (a.stats.lastMessageAt || 0) : (a.stats[field] || 0);
  var bValue = field === 'lastMessageAt' ? (b.stats.lastMessageAt || 0) : (b.stats[field] || 0);
  if (aValue === bValue) return a.name.localeCompare(b.name, userLocale(), { sensitivity: 'base' });
  return (aValue - bValue) * multiplier;
}

function renderTraffic() {
  var rows = document.getElementById('rows');
  var sorted = devices.slice().sort(compareDevices);
  var max24h = sorted.reduce(function(maximum, device) {
    return Math.max(maximum, device.stats.last24h || 0);
  }, 0);

  if (sorted.length === 0) {
    rows.innerHTML = '<tr><td colspan="5" class="state">' + escapeHtml(translate('settings.no_devices')) + '</td></tr>';
  } else {
    rows.innerHTML = sorted.map(function(device) {
      var width = max24h > 0
        ? Math.max(2, Math.round((device.stats.last24h / max24h) * 100))
        : 0;
      var meta = [
        device.zone,
        device.driverId,
        'EP' + device.endpoint,
        device.manufacturerName,
        device.modelId
      ].filter(Boolean).join(' · ');
      var mode = device.stats.mode === 'frames' ? translate('settings.frames') : translate('settings.activity');

      return '<tr>' +
        '<td>' +
          '<div class="device-name">' +
            '<span class="status-dot' + (device.available ? '' : ' offline') + '"></span>' +
            '<span>' + escapeHtml(device.name) + '</span>' +
            '<span class="mode">' + mode + '</span>' +
          '</div>' +
          '<div class="device-meta">' + escapeHtml(meta) + '</div>' +
          '<div class="pulse-track" aria-hidden="true">' +
            '<div class="pulse-bar" style="width:' + width + '%"></div>' +
          '</div>' +
        '</td>' +
        '<td class="number">' + formatNumber(device.stats.currentHour) + '</td>' +
        '<td class="number">' + formatNumber(device.stats.previousHour) + '</td>' +
        '<td class="number">' + formatNumber(device.stats.last24h) + '</td>' +
        '<td class="number">' + escapeHtml(formatTime(device.stats.lastMessageAt)) + '</td>' +
      '</tr>';
    }).join('');
  }

  var total = devices.reduce(function(sum, device) {
    return sum + (device.stats.last24h || 0);
  }, 0);
  var currentHourTotal = devices.reduce(function(sum, device) {
    return sum + (device.stats.currentHour || 0);
  }, 0);
  var top = devices.slice().sort(function(a, b) {
    return (b.stats.currentHour || 0) - (a.stats.currentHour || 0);
  })[0];
  document.getElementById('device-count').textContent = formatNumber(devices.length);
  document.getElementById('message-total').textContent = formatNumber(total);
  document.getElementById('current-hour-total').textContent = formatNumber(currentHourTotal);
  document.getElementById('top-talker').textContent = top ? top.name : '—';
}

function renderRejoins() {
  var affected = devices
    .filter(function(device) { return device.rejoinCount; })
    .sort(function(a, b) { return (b.rejoinCount || 0) - (a.rejoinCount || 0); });

  var rows = document.getElementById('rejoin-rows');
  if (affected.length === 0) {
    rows.innerHTML = '<tr><td colspan="3" class="state">' + escapeHtml(translate('settings.no_rejoins')) + '</td></tr>';
  } else {
    rows.innerHTML = affected.map(function(device) {
      return '<tr>' +
        '<td>' +
          '<div class="device-name">' +
            '<span>' + escapeHtml(device.name) + '</span>' +
          '</div>' +
        '</td>' +
        '<td class="number"><span class="rejoin-count-badge">' + formatNumber(device.rejoinCount) + '</span></td>' +
        '<td class="number">' + escapeHtml(formatTime(device.rejoinLastAt)) + '</td>' +
      '</tr>';
    }).join('');
  }

  var totalRejoins = affected.reduce(function(sum, device) { return sum + (device.rejoinCount || 0); }, 0);
  var since = devices.length ? devices[0].rejoinSince : null;
  document.getElementById('rejoin-total').textContent = formatNumber(totalRejoins);
  document.getElementById('rejoin-device-count').textContent = formatNumber(affected.length);
  document.getElementById('rejoin-since').textContent = formatDate(since);
}

function render() {
  renderTraffic();
  renderRejoins();
}

function loadStats() {
  if (!homeyApi || resetInFlight) return;
  var requestId = ++latestRequest;
  var refreshButton = document.getElementById('refresh');
  var resetButton = document.getElementById('reset');
  var resetRejoinsButton = document.getElementById('reset-rejoins');
  refreshButton.disabled = true;
  resetButton.disabled = true;
  resetRejoinsButton.disabled = true;
  refreshButton.textContent = translate('settings.refreshing');

  homeyApi.api('GET', '/message-stats?t=' + Date.now(), {}, function(error, result) {
    if (requestId !== latestRequest) return;
    refreshButton.disabled = false;
    resetButton.disabled = false;
    resetRejoinsButton.disabled = false;
    refreshButton.textContent = translate('settings.refresh');
    if (error) {
      document.getElementById('rows').innerHTML =
        '<tr><td colspan="5" class="state">' + escapeHtml(translate('settings.failed_load')) + ' ' +
        escapeHtml(error.message || error) + '</td></tr>';
      return;
    }
    devices = Array.isArray(result) ? result : [];
    document.getElementById('updated-at').textContent =
      translate('settings.updated_at') + ' ' + new Intl.DateTimeFormat(userLocale(), {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).format(new Date());
    render();
  });
}

function performReset() {
  latestRequest += 1;
  var refreshButton = document.getElementById('refresh');
  var resetButton = document.getElementById('reset');
  refreshButton.disabled = true;
  resetButton.disabled = true;
  resetButton.textContent = translate('settings.resetting');

  homeyApi.api('POST', '/message-stats/reset', {}, function(error) {
    resetInFlight = false;
    refreshButton.disabled = false;
    resetButton.disabled = false;
    resetButton.textContent = translate('settings.reset');

    if (error) {
      document.getElementById('updated-at').textContent =
        translate('settings.reset_failed') + ' ' + (error.message || error);
      return;
    }

    loadStats();
  });
}

function resetStats() {
  if (!homeyApi || resetInFlight) return;

  var message = translate('settings.reset_confirmation');
  var resetButton = document.getElementById('reset');
  resetInFlight = true;
  resetButton.disabled = true;

  function handleConfirmation(error, confirmed) {
    if (error || !confirmed) {
      resetInFlight = false;
      resetButton.disabled = false;
      if (error) {
        document.getElementById('updated-at').textContent =
          translate('settings.confirmation_failed') + ' ' + (error.message || error);
      }
      return;
    }

    performReset();
  }

  if (typeof homeyApi.confirm === 'function') {
    homeyApi.confirm(message, 'warning', handleConfirmation);
  } else {
    handleConfirmation(null, window.confirm(message));
  }
}

function performResetRejoins() {
  latestRequest += 1;
  var refreshButton = document.getElementById('refresh');
  var resetRejoinsButton = document.getElementById('reset-rejoins');
  refreshButton.disabled = true;
  resetRejoinsButton.disabled = true;
  resetRejoinsButton.textContent = translate('settings.resetting_rejoins');

  homeyApi.api('POST', '/rejoin-stats/reset', {}, function(error) {
    resetInFlight = false;
    refreshButton.disabled = false;
    resetRejoinsButton.disabled = false;
    resetRejoinsButton.textContent = translate('settings.reset_rejoins');

    if (error) {
      document.getElementById('updated-at').textContent =
        translate('settings.reset_rejoins_failed') + ' ' + (error.message || error);
      return;
    }

    loadStats();
  });
}

function resetRejoinsStats() {
  if (!homeyApi || resetInFlight) return;

  var message = translate('settings.reset_rejoins_confirmation');
  var resetRejoinsButton = document.getElementById('reset-rejoins');
  resetInFlight = true;
  resetRejoinsButton.disabled = true;

  function handleConfirmation(error, confirmed) {
    if (error || !confirmed) {
      resetInFlight = false;
      resetRejoinsButton.disabled = false;
      if (error) {
        document.getElementById('updated-at').textContent =
          translate('settings.confirmation_failed') + ' ' + (error.message || error);
      }
      return;
    }

    performResetRejoins();
  }

  if (typeof homeyApi.confirm === 'function') {
    homeyApi.confirm(message, 'warning', handleConfirmation);
  } else {
    handleConfirmation(null, window.confirm(message));
  }
}

document.querySelectorAll('.tab').forEach(function(button) {
  button.addEventListener('click', function() {
    switchTab(button.getAttribute('data-tab'));
  });
});
function loadAvailabilitySetting() {
  if (!homeyApi) return;
  var requestId = ++latestAvailabilityRequest;
  homeyApi.api('GET', '/availability-setting?t=' + Date.now(), {}, function(error, result) {
    if (requestId !== latestAvailabilityRequest) return;
    if (error || !result || typeof result.enabled !== 'boolean') return;
    document.getElementById('availability-toggle').checked = result.enabled;
  });
}

function setAvailabilitySetting(enabled) {
  var requestId = ++latestAvailabilityRequest;
  var toggle = document.getElementById('availability-toggle');
  var errorLabel = document.getElementById('availability-error');
  toggle.disabled = true;
  errorLabel.hidden = true;

  homeyApi.api('POST', '/availability-setting', { enabled: enabled }, function(error, result) {
    if (requestId !== latestAvailabilityRequest) return;
    toggle.disabled = false;
    if (error) {
      toggle.checked = !enabled;
      errorLabel.hidden = false;
      errorLabel.textContent = translate('settings.availability_switch_failed') + ' ' + (error.message || error);
      return;
    }
    toggle.checked = result && typeof result.enabled === 'boolean' ? result.enabled : enabled;
    if (result && result.restoreFailures > 0) {
      errorLabel.hidden = false;
      errorLabel.textContent = translate('settings.availability_switch_partial_restore')
        .replace('{n}', result.restoreFailures);
    }
    loadStats();
  });
}

document.getElementById('availability-toggle').addEventListener('change', function(event) {
  setAvailabilitySetting(event.target.checked);
});

document.getElementById('refresh').addEventListener('click', loadStats);
document.getElementById('reset').addEventListener('click', resetStats);
document.getElementById('reset-rejoins').addEventListener('click', resetRejoinsStats);
document.getElementById('sort').addEventListener('change', function(event) {
  currentSort = event.target.value;
  renderTraffic();
});
document.querySelectorAll('#panel-traffic th button[data-sort]').forEach(function(button) {
  button.addEventListener('click', function() {
    currentSort = button.getAttribute('data-sort');
    document.getElementById('sort').value = currentSort;
    renderTraffic();
  });
});

function onHomeyReady(Homey) {
  homeyApi = Homey;
  Homey.ready();
  loadStats();
  loadAvailabilitySetting();
  setInterval(loadStats, 60 * 1000);
}
