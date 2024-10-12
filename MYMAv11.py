import MetaTrader5 as mt5
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from sklearn.preprocessing import MinMaxScaler
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout
from tensorflow.keras.callbacks import EarlyStopping

# Initialize and set up the MetaTrader connection
def main():
    if not mt5.initialize():
        raise Exception("MetaTrader5 initialization failed")

    login = 312128713
    password = "Sexo247420@"
    server = "XMGlobal-MT5 7"

    if mt5.login(login=login, password=password, server=server):
        print("Connected to MetaTrader 5 for data retrieval")
        perform_backtest()
    else:
        raise Exception("Failed to connect to MetaTrader 5")

def fetch_historical_data(symbol, timeframe, start_date, days):
    utc_from = pd.Timestamp(start_date).to_pydatetime()
    rates = mt5.copy_rates_from(symbol, timeframe, utc_from, days)
    if rates is None or len(rates) == 0:
        raise Exception(f"Failed to retrieve rates for {start_date}")
    
    df = pd.DataFrame(rates)
    df['time'] = pd.to_datetime(df['time'], unit='s')
    return df[['time', 'close']]

def preprocess_data(data):
    scaler = MinMaxScaler(feature_range=(0, 1))
    scaled_data = scaler.fit_transform(data['close'].values.reshape(-1, 1))
    return scaled_data, scaler

def train_lstm_model(train_data, validation_data, time_step=60):
    X_train, y_train = create_train_data(train_data, time_step)
    X_val, y_val = create_train_data(validation_data, time_step)

    model = Sequential()
    model.add(LSTM(100, return_sequences=True, input_shape=(X_train.shape[1], 1)))
    model.add(Dropout(0.2))
    model.add(LSTM(100, return_sequences=False))
    model.add(Dropout(0.2))
    model.add(Dense(50))
    model.add(Dense(1))
    model.compile(optimizer='adam', loss='mean_squared_error')

    early_stopping = EarlyStopping(monitor='val_loss', patience=5, restore_best_weights=True)
    model.fit(X_train, y_train, validation_data=(X_val, y_val), epochs=50, batch_size=32, callbacks=[early_stopping])

    return model

def create_train_data(scaled_data, time_step):
    X, y = [], []
    for i in range(time_step, len(scaled_data)):
        X.append(scaled_data[i-time_step:i, 0])
        y.append(scaled_data[i, 0])
    X = np.array(X)
    y = np.array(y)
    X = np.reshape(X, (X.shape[0], X.shape[1], 1))
    return X, y

def perform_backtest():
    symbol = "BTCUSD"
    timeframe = mt5.TIMEFRAME_M30  # 30-minute timeframe
    train_start_date = '2020-01-01'
    train_end_date = '2022-12-31'
    test_start_date = '2023-01-01'
    test_end_date = '2023-09-07'

    # Fetch and preprocess historical data
    train_data = fetch_historical_data(symbol, timeframe, train_start_date, days=1000)  # 2020-2022
    test_data = fetch_historical_data(symbol, timeframe, test_start_date, days=250)  # 2023 (250 days)
    
    scaled_train_data, scaler = preprocess_data(train_data)
    
    # Split into train and validation sets
    split_idx = int(len(scaled_train_data) * 0.8)
    train_set = scaled_train_data[:split_idx]
    val_set = scaled_train_data[split_idx:]

    # Train LSTM model
    model = train_lstm_model(train_set, val_set)

    # Now backtest on the 2023 data
    backtest_on_2023(model, test_data, scaler)

def backtest_on_2023(model, data, scaler, time_step=60):
    balance = 1000  # Starting balance
    leverage = 5
    stop_loss_pct = 0.02  # 2% stop loss
    trade_log = []
    rewards = []

    fig, ax = plt.subplots(figsize=(12, 6))

    def update_plot(day_index):
        nonlocal balance

        # Extract data for current day
        current_data = data[day_index - time_step:day_index]
        if len(current_data) < time_step:
            return  # Skip if there's insufficient data

        X_test = np.array([current_data['close'].values[-time_step:]])
        X_test = np.reshape(X_test, (1, time_step, 1))

        predicted_price = model.predict(X_test)[0][0]
        predicted_price = scaler.inverse_transform([[predicted_price]])[0][0]
        actual_price = data['close'].iloc[day_index]

        # Determine trade type
        trade_type = 'Buy' if predicted_price > actual_price else 'Sell'

        # Log the trade
        open_trade = {
            'time': data['time'].iloc[day_index],
            'entry_price': actual_price,
            'trade_type': trade_type,
            'exit_time': data['time'].iloc[day_index + 1],
            'exit_price': data['close'].iloc[day_index + 1]
        }
        trade_log.append(open_trade)

        # Update plot
        ax.clear()
        ax.plot(data['time'].iloc[:day_index], data['close'].iloc[:day_index], label='Close Price')
        ax.scatter([open_trade['time']], [open_trade['entry_price']], color='green' if trade_type == 'Buy' else 'red', label=f'{trade_type} Entry')
        ax.set_title(f"Day {day_index + 1} Balance: {balance:.2f}")
        ax.legend()
        ax.grid()

    ani = FuncAnimation(fig, update_plot, frames=len(data), interval=100)
    plt.show()

if __name__ == "__main__":
    main()
