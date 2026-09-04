function canPlayerSelect(token, user) {
  if (!user || user.isGM) return false;
  if (token.isPreview || !token.layer?.active) return false;
  if (token.visible === false) return false;
  const doc = token.document;
  if (!doc || doc.hidden || doc.isSecret) return false;
  return Boolean(token.actor);
}

function canUpdateToken(token, user) {
  if (token.isPreview || !token.layer?.active) return false;
  return Boolean(token.document?.canUserModify?.(user, "update"));
}

export function enablePlayerTokenSelect() {
  const proto = CONFIG.Token?.objectClass?.prototype;
  if (!proto || proto._irisSelectOnly) return;
  proto._irisSelectOnly = true;

  const originalControl = proto._canControl;
  const originalDrag = proto._canDrag;
  const originalDragStart = proto._canDragLeftStart;

  proto._canControl = function(user, event) {
    if (originalControl.call(this, user, event)) return true;
    return canPlayerSelect(this, user);
  };

  proto._canDrag = function(user, event) {
    if (!canUpdateToken(this, user)) return false;
    return originalDrag.call(this, user, event);
  };

  if (typeof originalDragStart === "function") {
    proto._canDragLeftStart = function(user, event, options) {
      if (!canUpdateToken(this, user)) return false;
      return originalDragStart.call(this, user, event, options);
    };
  }
}
