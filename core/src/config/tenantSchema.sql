-- EKAFY Tenant Database Blueprint
-- This schema is executed every time a new customer is provisioned via the Server Manager.

-- ==========================================
-- Module 1: Employee Management
-- ==========================================

CREATE TABLE IF NOT EXISTS employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(320) UNIQUE,
  phone VARCHAR(20),
  role VARCHAR(100) DEFAULT 'Employee',
  salary DECIMAL(10,2) DEFAULT 0.00,
  hire_date DATE,
  status ENUM('Active', 'On Leave', 'Terminated') DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT NOT NULL,
  record_date DATE NOT NULL,
  clock_in TIME,
  clock_out TIME,
  status ENUM('Present', 'Absent', 'Half-Day', 'Leave') DEFAULT 'Present',
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

-- ==========================================
-- Module 2: Quotation System
-- ==========================================

CREATE TABLE IF NOT EXISTS quotations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_name VARCHAR(150) NOT NULL,
  client_email VARCHAR(320),
  client_phone VARCHAR(20),
  total_amount DECIMAL(12,2) DEFAULT 0.00,
  status ENUM('Draft', 'Sent', 'Accepted', 'Rejected') DEFAULT 'Draft',
  valid_until DATE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quotation_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  quotation_id INT NOT NULL,
  description VARCHAR(255) NOT NULL,
  quantity INT DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL,
  total_price DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
);
