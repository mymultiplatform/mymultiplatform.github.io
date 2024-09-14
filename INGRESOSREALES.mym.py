import tkinter as tk
from tkinter import ttk
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import numpy as np
import datetime as dt

# Function to create the plot
def plot_graph():
    # Starting date (Jan 1, 2023) and ending date (Sep 13, 2024)
    start_date = dt.datetime(2023, 1, 1)
    end_date = dt.datetime(2024, 9, 13)
    
    # Total number of days between start and present time (Sep 13, 2024)
    num_days = (end_date - start_date).days
    
    # Set the initial earnings
    initial_earnings = 100
    
    # Target earnings in 2 years (1 million dollars)
    target_earnings = 1_000_000
    
    # Earnings grow linearly over 730 days (2 years)
    earnings_growth_per_day = target_earnings / 730
    
    # Generate the dates for the plot
    dates = [start_date + dt.timedelta(days=i) for i in range(num_days + 1)]
    
    # Calculate the earnings at each date
    earnings = [initial_earnings + i * earnings_growth_per_day for i in range(num_days + 1)]
    
    # Create a figure and plot
    fig, ax = plt.subplots(figsize=(9, 9))
    ax.plot(dates, earnings, label="Projected Earnings")
    
    # Format the plot
    ax.set_title('Earnings Growth (from $100 to $1M in 2 years)', fontsize=14)
    ax.set_xlabel('Date', fontsize=12)
    ax.set_ylabel('Earnings (in USD)', fontsize=12)
    ax.grid(True)
    ax.legend()
    
    # Embed the plot into the Tkinter window
    canvas = FigureCanvasTkAgg(fig, master=window)
    canvas.draw()
    canvas.get_tk_widget().pack()
    
    # Update the plot in the Tkinter window
    toolbar = canvas.get_tk_widget()
    toolbar.pack(side=tk.BOTTOM, fill=tk.BOTH, expand=True)

# Create the main Tkinter window
window = tk.Tk()
window.title('Earnings Projection')
window.geometry('900x900')

# Create a button to display the graph
button = ttk.Button(window, text="Display Earnings Graph", command=plot_graph)
button.pack(pady=20)

# Run the Tkinter event loop
window.mainloop()
