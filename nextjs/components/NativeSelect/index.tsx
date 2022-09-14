import React from 'react';
import classNames from 'classnames';
import Label from '../Label';
import styles from './index.module.css';

interface Option {
  label: string;
  value: string;
}

interface Props {
  id: string;
  name?: string;
  label?: string;
  required?: boolean;
  defaultValue?: string;
  value?: string;
  disabled?: boolean;
  icon?: React.ReactNode;
  onChange?(event: React.ChangeEvent<HTMLSelectElement>): void;
  options: Option[];
  theme?: 'white' | 'blue' | 'gray';
}

function NativeSelect({
  id,
  name,
  required,
  label,
  defaultValue,
  value,
  disabled = false,
  icon,
  onChange,
  options,
  theme,
}: Props) {
  return (
    <>
      {label && <Label htmlFor={id}>{label}</Label>}
      <div
        className={classNames(styles.container, {
          [styles.blue]: theme === 'blue',
          [styles.disabled]: disabled,
        })}
      >
        {icon && <div className={styles.icon}>{icon}</div>}
        <select
          className={classNames(styles.select, {
            'bg-gray-50 text-gray-500': theme === 'gray',
          })}
          id={id}
          name={id || name}
          required={required}
          defaultValue={defaultValue}
          value={value}
          disabled={disabled}
          onChange={onChange}
        >
          {options.map((option: Option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

export default NativeSelect;
