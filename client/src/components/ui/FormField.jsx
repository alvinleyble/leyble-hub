import React, { useId } from 'react';

// Renders label ABOVE the input — no placeholder-as-label patterns allowed.
// Clones children to inject id, aria-required, and aria-invalid automatically.
export default function FormField({ label, error, hint, required, children, className = '' }) {
  const generatedId = useId();

  const child = React.Children.only(children);
  const inputId = child.props.id ?? generatedId;

  const enriched = React.cloneElement(child, {
    id: inputId,
    ...(required  && { 'aria-required': true }),
    ...(error     && { 'aria-invalid': 'true', 'aria-describedby': `${inputId}-err` }),
    ...(!error && hint && { 'aria-describedby': `${inputId}-hint` }),
  });

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={inputId} className="text-sm font-semibold text-slate-700">
        {label}
        {required && <span className="ml-1 text-red-600" aria-hidden="true">*</span>}
      </label>

      {hint && (
        <p id={`${inputId}-hint`} className="text-xs text-slate-500 -mt-1">{hint}</p>
      )}

      {enriched}

      {error && (
        <p id={`${inputId}-err`} role="alert" className="text-sm text-red-600 font-medium">
          {error}
        </p>
      )}
    </div>
  );
}
